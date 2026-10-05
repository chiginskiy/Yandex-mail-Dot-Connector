import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/mime.js';

test('HTML parser upgrades keep raw-text and foreign content hidden', () => {
  const hiddenFragments = [
    '<script/>hidden<script><img src="https://track.example.invalid"></script>',
    '<style/>hidden<style><img src="https://track.example.invalid"></style>',
    '<iframe><p>hidden</p><script>hidden</script></iframe>',
    '<svg><foreignObject><p>hidden</p></foreignObject><![CDATA[hidden]]></svg>',
    '<div hidden><form><form><p>hidden</p></form></div>',
  ];
  for (const fragment of hiddenFragments) {
    const result = htmlToText(`<p>Before</p>${fragment}<p>After</p>`);
    assert.equal(result.text, 'Before\n\nAfter', fragment);
    assert.equal(result.truncated, false);
  }
});

test('HTML parser upgrades preserve text and recover from stray foreign closing tags', () => {
  assert.equal(htmlToText('<p>Before</p></svg></math><p>After</p>').text, 'Before\n\nAfter');
  assert.equal(htmlToText('<textarea>Visible &amp; &lt;safe&gt;</textarea>').text, 'Visible & <safe>');
  assert.equal(htmlToText('<!-->Visible<!---> &amp; <?hidden?><p>After</p>').text, 'Visible &\nAfter');
});
