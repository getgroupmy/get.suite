import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../src/office/anchors.js';
import * as web from '../../web/src/apps/docs/outline.js';

test("the server's heading anchors are the web app's", () => {
  assert.equal(server.slugOf.toString(), web.slugOf.toString());
  assert.equal(server.anchorsOf.toString(), web.anchorsOf.toString());
  assert.deepEqual(server.anchorsOf([{ text: 'Café Prices' }, { text: 'Notes' }, { text: 'Notes' }, { text: '!!!' }]), ['cafe-prices', 'notes', 'notes-2', 'section']);
});
