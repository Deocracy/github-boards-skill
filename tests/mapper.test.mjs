// tests/mapper.test.mjs — unit tests for scripts/lib/mapper.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRules } from '../scripts/lib/mapper.mjs';

test('resolveRules returns defaults when config has no rules', () => {
  const r = resolveRules({});
  assert.equal(r.maxLanes, 8);
  assert.equal(r.useTags, false);
  assert.equal(r.defaultOwner, 'human');
  assert.equal(r.granularity, 'fine');
  assert.equal(r.escalateConfidenceBelow, 0.6);
  assert.equal(r.escalateBatchOver, 12);
});

test('resolveRules merges config.rules over defaults', () => {
  const r = resolveRules({ rules: { maxLanes: 5, defaultOwner: 'agent' } });
  assert.equal(r.maxLanes, 5);          // overridden
  assert.equal(r.defaultOwner, 'agent');// overridden
  assert.equal(r.granularity, 'fine');  // default preserved
});

test('resolveRules ignores a non-object rules value', () => {
  assert.equal(resolveRules({ rules: 'nope' }).maxLanes, 8);
  assert.equal(resolveRules({ rules: ['a'] }).maxLanes, 8);
  assert.equal(resolveRules(null).maxLanes, 8);
});

import { prepareInput } from '../scripts/lib/mapper.mjs';

const cfg = { stageOptions: { Ideas: 'o1', Building: 'o2', Shipped: 'o3' }, rules: { maxLanes: 6 } };
const ledgerWith = (cands) => ({ ledgerVersion: 1, intent: {}, candidates: cands });

test('prepareInput packs only status:candidate items, mapping to {candidateId,title,note,source}', () => {
  const ledger = ledgerWith([
    { id: 'a', title: 'Do X', note: 'n', source: 's', status: 'candidate' },
    { id: 'b', title: 'Done already', note: '', source: 's', status: 'mapped' },
  ]);
  const pkt = prepareInput(ledger, cfg, null);
  assert.equal(pkt.candidates.length, 1);
  assert.deepEqual(pkt.candidates[0], { candidateId: 'a', title: 'Do X', note: 'n', source: 's' });
});

test('prepareInput exposes allowedLanes, allowedOwners, defaultLane, rules, session', () => {
  const pkt = prepareInput(ledgerWith([]), cfg, 'working on auth');
  assert.deepEqual(pkt.allowedLanes, ['Ideas', 'Building', 'Shipped']);
  assert.deepEqual(pkt.allowedOwners, ['agent', 'human']);
  assert.equal(pkt.defaultLane, 'Ideas');
  assert.equal(pkt.rules.maxLanes, 6);
  assert.equal(pkt.session, 'working on auth');
});

test('prepareInput tolerates a missing/empty ledger', () => {
  const pkt = prepareInput(null, cfg, null);
  assert.deepEqual(pkt.candidates, []);
});

import { validateProposal } from '../scripts/lib/mapper.mjs';

const vcfg = { stageOptions: { Ideas: 'o1', Building: 'o2' } };
const rules = resolveRules({});
const card = (over = {}) => ({ candidateId: 'a', kind: 'card', title: 'T', lane: 'Building', owner: 'agent', confidence: 0.9, ...over });

test('validateProposal accepts a well-formed card', () => {
  assert.deepEqual(validateProposal(card(), vcfg, rules), { ok: true, errors: [] });
});

test('validateProposal rejects an invented lane', () => {
  const v = validateProposal(card({ lane: 'Nope' }), vcfg, rules);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /lane 'Nope' not in allowed/);
});

test('validateProposal rejects a bad owner and bad kind and bad confidence', () => {
  assert.match(validateProposal(card({ owner: 'bot' }), vcfg, rules).errors.join(' '), /owner/);
  assert.match(validateProposal(card({ kind: 'epic' }), vcfg, rules).errors.join(' '), /invalid kind/);
  assert.match(validateProposal(card({ confidence: 2 }), vcfg, rules).errors.join(' '), /confidence/);
});

test('validateProposal requires candidateId', () => {
  assert.match(validateProposal(card({ candidateId: undefined }), vcfg, rules).errors.join(' '), /candidateId/);
});

test('validateProposal: comment requires an integer commentTarget; lane/owner not required', () => {
  assert.equal(validateProposal({ candidateId: 'a', kind: 'comment', title: 'note', commentTarget: 12, confidence: 0.8 }, vcfg, rules).ok, true);
  assert.match(validateProposal({ candidateId: 'a', kind: 'comment', title: 'note', commentTarget: null, confidence: 0.8 }, vcfg, rules).errors.join(' '), /commentTarget/);
});

test('validateProposal: split children must each have an allowed lane + valid owner', () => {
  const ok = card({ split: [{ title: 'c1', lane: 'Ideas', owner: 'human' }, { title: 'c2', lane: 'Building', owner: 'agent' }] });
  assert.equal(validateProposal(ok, vcfg, rules).ok, true);
  const bad = card({ split: [{ title: 'c1', lane: 'Ghost', owner: 'human' }] });
  assert.equal(validateProposal(bad, vcfg, rules).ok, false);
});

test('validateProposal: skip needs neither lane nor owner', () => {
  assert.equal(validateProposal({ candidateId: 'a', kind: 'skip', title: 'noise', confidence: 0.95 }, vcfg, rules).ok, true);
});

test('validateProposal rejects contradictory proposals (mutually-exclusive intents)', () => {
  // skip + split is contradictory
  assert.equal(validateProposal({ candidateId: 'a', kind: 'skip', title: 'x', confidence: 0.9, split: [{ title: 'c', lane: 'Building', owner: 'agent' }, { title: 'd', lane: 'Ideas', owner: 'human' }] }, vcfg, rules).ok, false);
  // two dispositions at once
  assert.equal(validateProposal({ candidateId: 'a', kind: 'card', title: 'x', lane: 'Building', owner: 'agent', confidence: 0.9, mergeWith: 'b', needsDecision: { question: 'q', options: [] } }, vcfg, rules).ok, false);
});
