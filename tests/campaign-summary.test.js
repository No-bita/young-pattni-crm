import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignSummary } from '../web/src/campaign-summary.js';

test('campaign summary uses total rows for Sent and exclusive delivery outcomes', () => {
 const counts = {sent:5,delivered:7,read:11,failed:2,skipped_suppressed:3,cancelled:4,pending:1,queued:6,sending:2};
 const before = {...counts};
 assert.deepEqual(campaignSummary(counts), {total:41,delivered:7,read:11,failed:9,awaiting:14});
 assert.deepEqual(counts,before);
});
test('campaign summary keeps accepted but unconfirmed messages out of Failed', () => {
 assert.deepEqual(campaignSummary({sent:3}), {total:3,delivered:0,read:0,failed:0,awaiting:3});
});
test('campaign summary has zero counts before recipient rows exist', () => {
 assert.deepEqual(campaignSummary(), {total:0,delivered:0,read:0,failed:0,awaiting:0});
});
test('settled campaign outcomes add up without changing stored reasons', () => {
 const summary = campaignSummary({delivered:2,read:8,failed:1,cancelled:4,skipped_suppressed:2});
 assert.equal(summary.total,summary.delivered+summary.read+summary.failed);
 assert.equal(summary.awaiting,0);
});
