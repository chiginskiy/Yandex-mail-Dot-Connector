import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { ImapFlow } from 'imapflow';
import { forceYandexXOAuth2, performOperation } from '../src/imap.js';
import { LIMITS } from '../src/validation.js';

test('real ImapFlow: server Sent discovery, HTML fallback and exact split encoded attachment BODY.PEEK', {timeout:10000}, async()=>{
  const commands=[], sockets=new Set();
  const html=Buffer.from('<p>Привет &amp; HTML</p><script>hidden()</script><img src="https://invalid.example/track">');
  const raw=Buffer.concat([Buffer.alloc(LIMITS.attachmentChunkBytes-1,65),Buffer.from('=CF=F0=E8=E2=E5=F2\r\n=\r\nend')]);
  const structure=`(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${html.length} 1 NIL NIL NIL NIL)("TEXT" "PLAIN" ("CHARSET" "WINDOWS-1251" "NAME" "legacy.txt") NIL NIL "QUOTED-PRINTABLE" ${raw.length} 2 NIL ("INLINE" ("FILENAME" "legacy.txt")) NIL NIL) "MIXED")`;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.write('* OK Synthetic fixture\r\n');let buffered='';
    socket.on('data',data=>{
      buffered+=data.toString();
      while(buffered.includes('\r\n')){
        const end=buffered.indexOf('\r\n'), line=buffered.slice(0,end);buffered=buffered.slice(end+2);commands.push(line);
        const [tag,...tokens]=line.split(' '), command=tokens.join(' ');
        if(command==='CAPABILITY')socket.write(`* CAPABILITY IMAP4rev1 NAMESPACE SPECIAL-USE\r\n${tag} OK capabilities\r\n`);
        else if(command.startsWith('AUTHENTICATE XOAUTH2 '))socket.write(`${tag} OK authenticated\r\n`);
        else if(command==='NAMESPACE')socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK namespace\r\n`);
        else if(command.startsWith('LIST')||command.startsWith('LSUB'))socket.write(`* LIST () "/" "INBOX"\r\n* LIST (\\Sent) "/" "ServerSent"\r\n* LIST () "/" "Sent"\r\n${tag} OK list\r\n`);
        else if(command.startsWith('EXAMINE'))socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 42] valid\r\n* OK [UIDNEXT 9] next\r\n${tag} OK [READ-ONLY] examined\r\n`);
        else if(command.startsWith('UID FETCH')){
          const chunks=[Buffer.from(`* 1 FETCH (UID 8 RFC822.SIZE ${raw.length+1024}`)];
          if(command.includes('BODYSTRUCTURE'))chunks.push(Buffer.from(' BODYSTRUCTURE '+structure));
          for(const match of command.matchAll(/BODY\.PEEK\[([^\]]+)\](?:<(\d+)\.(\d+)>)?/g)){
            const part=match[1],start=Number(match[2]??0),limit=Number(match[3]??0);
            const all=part==='1.MIME'?Buffer.from('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'):part==='1'?html:part==='2'?raw:Buffer.alloc(0);
            const bytes=limit?all.subarray(start,start+limit):all;
            chunks.push(Buffer.from(` BODY[${part}]${limit?'<'+start+'>':''} {${bytes.length}}\r\n`),bytes);
          }
          chunks.push(Buffer.from(`)\r\n${tag} OK fetch\r\n`));socket.write(Buffer.concat(chunks));
        } else socket.write(`${tag} BAD unsupported fixture\r\n`);
      }
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=forceYandexXOAuth2(new ImapFlow({host:'127.0.0.1',port:server.address().port,secure:false,doSTARTTLS:false,logger:false,auth:{user:'synthetic@example.invalid',accessToken:'synthetic-fixture'},disableAutoIdle:true,disableAutoEnable:true,disableBinary:true,disableCompression:true,socketTimeout:3000,maxLiteralSize:128*1024,maxResponseSize:256*1024}));client.on('error',()=>{});
  try{
    await client.connect();
    const folders=await performOperation(client,'discover',{allowedMailboxes:['INBOX']});
    assert.equal(folders.sentMailbox,'ServerSent',JSON.stringify(folders));assert.equal(folders.folders.find(f=>f.path==='ServerSent').specialUseSource,'extension');
    assert.ok(!commands.some(line=>/\b(?:SELECT|EXAMINE|SEARCH|FETCH)\b/.test(line)));
    const body=await performOperation(client,'read',{mailbox:'INBOX',uid:8,uidValidity:'42'});
    assert.equal(body.text,'Привет & HTML');assert.equal(body.textSource,'html_to_text');assert.equal(body.attachments[0].contentTransferEncoding,'quoted-printable');assert.equal(body.attachments[0].encodedSize,raw.length);
    const first=await performOperation(client,'attachment',{mailbox:'INBOX',uid:8,uidValidity:'42',part:'2',offset:0});
    const last=await performOperation(client,'attachment',{mailbox:'INBOX',uid:8,uidValidity:'42',part:'2',offset:first.nextOffset});
    assert.equal(first.done,false);assert.equal(last.done,true);assert.deepEqual(Buffer.concat([Buffer.from(first.dataBase64,'base64'),Buffer.from(last.dataBase64,'base64')]),raw);
    assert.ok(commands.some(line=>line.includes('BODY.PEEK[2]<0.131072>')));assert.ok(commands.some(line=>line.includes('BODY.PEEK[2]<131072.')));
    assert.ok(!commands.some(line=>/\b(?:STORE|APPEND|DELETE|EXPUNGE|CLOSE|SELECT|MOVE|COPY|CREATE|RENAME|SUBSCRIBE|UNSUBSCRIBE)\b/.test(line)));
    assert.ok(!commands.some(line=>/BINARY(?:\.PEEK)?\[/.test(line)));
  }finally{client.close();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}
});
