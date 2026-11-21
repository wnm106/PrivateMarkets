import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachmentDelivery } from './chat-attachments';

describe('attachmentDelivery', () => {
  it('shows a plain picture or a PDF in place, with its own type', () => {
    assert.deepEqual(attachmentDelivery('image/png'), { contentType: 'image/png', disposition: 'inline' });
    assert.deepEqual(attachmentDelivery('image/jpeg'), { contentType: 'image/jpeg', disposition: 'inline' });
    assert.deepEqual(attachmentDelivery('image/gif'), { contentType: 'image/gif', disposition: 'inline' });
    assert.deepEqual(attachmentDelivery('image/webp'), { contentType: 'image/webp', disposition: 'inline' });
    assert.deepEqual(attachmentDelivery('application/pdf'), { contentType: 'application/pdf', disposition: 'inline' });
    assert.deepEqual(attachmentDelivery(' IMAGE/PNG ; charset=binary'), { contentType: 'image/png', disposition: 'inline' });
  });

  it('downloads anything that could run as a page, whatever type was claimed', () => {
    const download = { contentType: 'application/octet-stream', disposition: 'attachment' };
    for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'text/plain', 'text/csv', 'application/json', 'image/bmp', 'image/x-icon', 'application/octet-stream']) {
      assert.deepEqual(attachmentDelivery(type), download, type);
    }
    // A type dressed up to pass a prefix check.
    assert.deepEqual(attachmentDelivery('image/svg+xml;image/png'), download);
    assert.deepEqual(attachmentDelivery('text/html, image/png'), download);
    assert.deepEqual(attachmentDelivery('image/'), download);
    assert.deepEqual(attachmentDelivery(''), download);
    assert.deepEqual(attachmentDelivery(null), download);
  });
});
