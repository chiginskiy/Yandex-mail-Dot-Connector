import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { ImapFlow } from 'imapflow';
import { forceYandexXOAuth2, performOperation, verifyYandexToken } from '../src/imap.js';
import { validateInput } from '../src/validation.js';

/** Local synthetic IMAP transcript. No TLS credentials or external hosts. */
async function syntheticServer({preauth=false}={}) {
  const commands=[]; const sockets=new Set(); const body='Synthetic body from a local mock.\r\n';
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{});
    socket.write(`* ${preauth?'PREAUTH':'OK'} Synthetic test server\r\n`);let buffered='';
    socket.on('data',data=>{
      buffered+=data.toString();
      while(buffered.includes('\r\n')) {
        const end=buffered.indexOf('\r\n');const line=buffered.slice(0,end);buffered=buffered.slice(end+2);
        commands.push(line);const [tag,...rest]=line.split(' ');const command=rest.join(' ');
        if(command==='CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN NAMESPACE\r\n${tag} OK capabilities\r\n`);
        else if(command.startsWith('AUTHENTICATE XOAUTH2 ')) socket.write(`${tag} OK authenticated\r\n`);
        else if(command==='NAMESPACE') socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK namespace\r\n`);
        else if(command.startsWith('LIST') || command.startsWith('LSUB')) socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK list\r\n`);
        else if(command.startsWith('EXAMINE ')) socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 42] valid\r\n* OK [UIDNEXT 9] next\r\n${tag} OK [READ-ONLY] examined\r\n`);
        else if(command.startsWith('UID SEARCH')) socket.write(`* SEARCH 8\r\n${tag} OK search\r\n`);
        else if(command.startsWith('UID FETCH')) {
          let attributes='UID 8 FLAGS () RFC822.SIZE 150';
          if(command.includes('ENVELOPE')) attributes+=' ENVELOPE ("01-Jan-2026 00:00:00 +0000" "Synthetic subject" (("Test" NIL "test" "example.invalid")) NIL NIL ((NIL NIL "owner" "example.invalid")) NIL NIL NIL "<synthetic@example.invalid>")';
          if(command.includes('BODYSTRUCTURE')) attributes+=' BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 34 1 NIL NIL NIL NIL)';
          if(command.includes('BODY.PEEK[HEADER]')) {
            const headers='Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n';
            attributes+=` BODY[HEADER] {${Buffer.byteLength(headers)}}\r\n${headers}`;
          }
          if(command.includes('BODY.PEEK[TEXT]')) attributes+=` BODY[TEXT]<0> {${Buffer.byteLength(body)}}\r\n${body}`;
          socket.write(`* 1 FETCH (${attributes})\r\n${tag} OK fetch\r\n`);
        } else if(command==='LOGOUT') socket.end(`* BYE\r\n${tag} OK logout\r\n`);
        else socket.write(`${tag} BAD unsupported synthetic command\r\n`);
      }
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {commands,port:server.address().port,async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}

test('real ImapFlow authenticates unadvertised XOAUTH2 and emits EXAMINE/BODY.PEEK only', {timeout:5000}, async()=>{
  const mock=await syntheticServer();
  const client=forceYandexXOAuth2(new ImapFlow({host:'127.0.0.1',port:mock.port,secure:false,doSTARTTLS:false,logger:false,auth:{user:'owner@example.invalid',accessToken:'synthetic-token'},disableAutoIdle:true,disableAutoEnable:true,disableCompression:true,socketTimeout:2000}));
  client.on('error',()=>{});
  try {
    await client.connect();
    const listed=await performOperation(client,'list',validateInput('list',{limit:1},['INBOX']));
    assert.equal(listed.messages[0].uid,8);assert.equal(listed.messages[0].subject,'Synthetic subject');
    const read=await performOperation(client,'read',{mailbox:'INBOX',uid:8,uidValidity:'42'});
    assert.equal(read.text,'Synthetic body from a local mock.\r\n');assert.equal(read.bodyStatus,'ok');
    const auth=mock.commands.find(line=>line.includes('AUTHENTICATE '));
    assert.match(auth,/AUTHENTICATE XOAUTH2 /);
    assert.equal(Buffer.from(auth.split(' ').at(-1),'base64').toString(),'user=owner@example.invalid\x01auth=Bearer synthetic-token\x01\x01');
    assert.ok(mock.commands.some(line=>line.includes(' EXAMINE INBOX')));
    assert.ok(mock.commands.some(line=>line.includes('BODY.PEEK[TEXT]<0.8192>')));
    assert.ok(!mock.commands.some(line=>/\b(?:STORE|APPEND|DELETE|EXPUNGE|CLOSE|SELECT|MOVE|COPY|CREATE|RENAME|SUBSCRIBE|UNSUBSCRIBE)\b/.test(line)));
    for(const line of mock.commands.filter(line=>line.includes(' FETCH '))) assert.ok(!/BODY\[/.test(line));
  } finally {client.close();await mock.close();}
});

test('OAuth ownership verifier accepts completed XOAUTH2 despite ImapFlow boolean authenticated', {timeout:5000},async()=>{
  const mock=await syntheticServer();
  try {
    const result=await verifyYandexToken('owner@example.invalid','synthetic-token',{createClient:(owner,accessToken)=>{
      const client=forceYandexXOAuth2(new ImapFlow({host:'127.0.0.1',port:mock.port,secure:false,doSTARTTLS:false,logger:false,auth:{user:owner,accessToken},disableAutoIdle:true,disableAutoEnable:true,socketTimeout:2000}));client.on('error',()=>{});return client;
    }});
    assert.equal(result,true);
    assert.ok(mock.commands.some(line=>line.includes('AUTHENTICATE XOAUTH2')));
    assert.ok(!mock.commands.some(line=>/\b(?:EXAMINE|SELECT|FETCH|SEARCH)\b/.test(line)));
  } finally {await mock.close();}
});

test('OAuth ownership verifier rejects a PREAUTH greeting without sending credentials', {timeout:5000},async()=>{
  const mock=await syntheticServer({preauth:true});
  try {
    const result=await verifyYandexToken('owner@example.invalid','synthetic-token',{createClient:(owner,accessToken)=>{
      const client=forceYandexXOAuth2(new ImapFlow({host:'127.0.0.1',port:mock.port,secure:false,doSTARTTLS:false,logger:false,auth:{user:owner,accessToken},disableAutoIdle:true,disableAutoEnable:true,socketTimeout:2000}));client.on('error',()=>{});return client;
    }});
    assert.equal(result,false);assert.ok(!mock.commands.some(line=>line.includes('AUTHENTICATE')));
  } finally {await mock.close();}
});
