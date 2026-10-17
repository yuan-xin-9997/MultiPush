import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkDiagnostic } from '../packages/publisher-engine/src/browser-manager.ts';
test('网络诊断仅保存结构，不保留token、文件名、用户参数或载荷内容', () => {
  const row = networkDiagnostic('POST', 'https://mp.weixin.qq.com/cgi-bin/private-name?token=DO_NOT_LEAK&name=private.png', 'multipart/form-data; boundary=private-boundary', 123);
  assert.equal(row.pathShape, '/cgi-bin/_');
  assert.equal(row.contentType, 'multipart/form-data');
  assert.equal(row.bodyBytes, 123);
  assert.doesNotMatch(JSON.stringify(row), /DO_NOT_LEAK|private|token|boundary/);
});
