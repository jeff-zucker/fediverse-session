// library.test.mjs — the library stands alone and does what it says, with
// every server it talks to stubbed: it imports nothing but its own files,
// names no application, tells a Mastodon address from a pod one, and acts
// through each.
//
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(p, 'utf8');
// Comment lines are dropped whole: the rules are about code, and prose that
// names an application is not a violation.
const code = (src) => {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.endsWith('*/') || t === '*/') inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out.join('\n');
};

test('imports nothing above itself, names no application, tells a Mastodon address from a pod one and acts through each', async () => {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const files = fs.readdirSync(SESSION).filter((f) => f.endsWith('.mjs'));
  let bad = 0;
  for (const f of files) {
    const src = code(read(path.join(SESSION, f)));
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('./')) { fail(`${f} imports ${m[1]} — the session library imports nothing but its own files`); bad++; }
    }
    if (/fedipod/i.test(src)) { fail(`${f} names FediPod in code — the database and client names are the caller's`); bad++; }
  }
  const { solidOidcSession } = await import(path.join(SESSION, 'oidc-session.mjs'));
  const oidc = solidOidcSession({ dbName: 'x', clientName: 'y' });
  for (const k of ['beginLogin', 'completeLogin', 'getSession', 'signOut']) {
    if (typeof oidc[k] !== 'function') { fail(`solidOidcSession() returned no ${k}`); bad++; }
  }
  // An address at a Gateway resolves to the POD's login, through the alias
  // WebFinger names; an address on a Mastodon server is refused in words.
  const { fediLogin, parseAddress } = await import(path.join(SESSION, 'fedi-login.mjs'));
  const jrd = (host, aliases, self) => ({ ok: true, json: async () => ({ aliases, links: [{ rel: 'self', type: 'application/activity+json', href: self }] }) });
  const stub = async (url) => {
    if (url.startsWith('https://front.example/.well-known/webfinger')) return jrd('front.example', ['https://mei.pod.example/anything/ap/actor'], 'https://front.example/u/mei/ap/actor');
    if (url.startsWith('https://masto.example/.well-known/webfinger')) return jrd('masto.example', ['https://masto.example/@kwame'], 'https://masto.example/users/kwame');
    if (url === 'https://mei.pod.example/.well-known/openid-configuration') return { ok: true, json: async () => ({ issuer: 'https://pod.example/', authorization_endpoint: 'https://pod.example/.oidc/auth' }) };
    // A pod whose host answers no discovery: the actor names the WebID, and
    // the WebID document names the issuer.
    if (url.startsWith('https://server.example/.well-known/webfinger')) return jrd('server.example', [], 'https://server.example/aisha/anything/ap/actor');
    if (url === 'https://server.example/aisha/anything/ap/actor') return { ok: true, json: async () => ({ id: url, alsoKnownAs: ['https://server.example/aisha/profile/card#me'] }) };
    if (url === 'https://server.example/aisha/profile/card#me') return { ok: true, json: async () => ([{ '@id': url, 'http://www.w3.org/ns/solid/terms#oidcIssuer': [{ '@id': 'https://idp.example/' }] }]) };
    if (url === 'https://idp.example/.well-known/openid-configuration') return { ok: true, json: async () => ({ issuer: 'https://idp.example/', authorization_endpoint: 'https://idp.example/auth' }) };
    return { ok: false, json: async () => ({}) };
  };
  const login = fediLogin({ dbName: 'x', fetch: stub });
  const found = await login.resolve('@mei@front.example').catch((e) => ({ error: e.message }));
  if (found.issuer !== 'https://pod.example/' || found.origin !== 'https://mei.pod.example' || found.actor !== 'https://front.example/u/mei/ap/actor') {
    fail(`a fronted address did not resolve to its pod's login: ${JSON.stringify(found)}`); bad++;
  }
  const viaWebId = await login.resolve('@aisha@server.example').catch((e) => ({ error: e.message }));
  if (viaWebId.issuer !== 'https://idp.example/' || viaWebId.webId !== 'https://server.example/aisha/profile/card#me') {
    fail(`an address on a host without discovery did not resolve through its WebID: ${JSON.stringify(viaWebId)}`); bad++;
  }
  const typedWebId = await login.resolve('https://server.example/aisha/profile/card#me').catch((e) => ({ error: e.message }));
  if (typedWebId.issuer !== 'https://idp.example/') { fail(`a typed WebID did not resolve: ${JSON.stringify(typedWebId)}`); bad++; }
  const refused = await login.resolve('kwame@masto.example').then(() => '', (e) => e.message);
  if (!/masto\.example is not a Solid pod/.test(refused)) { fail(`a Mastodon address was not refused in words: ${refused || 'resolved'}`); bad++; }
  if (parseAddress('nonsense') !== null || parseAddress('@mei@Front.Example')?.at !== '@mei@front.example') { fail('parseAddress does not read @you@host'); bad++; }
  // The account library tells a Mastodon address from a pod address and
  // speaks to each: the Mastodon API for one, the outbox door for the other.
  const { fediAccount, BROWSER_ACCOUNT_NOTICE } = await import(path.join(SESSION, 'fedi-account.mjs'));
  const seen = [];
  const acctStub = async (url, init = {}) => {
    seen.push(`${init.method || 'GET'} ${url}`);
    const ok = (body, headers = {}) => ({ ok: true, status: 200, headers: { get: (k) => headers[k] || null }, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.startsWith('https://masto.example/.well-known/webfinger')) return jrd('masto.example', ['https://masto.example/@kwame'], 'https://masto.example/users/kwame');
    if (url === 'https://masto.example/api/v1/instance') return ok({ uri: 'masto.example', title: 'Masto' });
    if (url === 'https://masto.example/api/v1/statuses' && init.method === 'POST') return ok({ id: '77', url: 'https://masto.example/@kwame/77' });
    if (url.startsWith('https://masto.example/api/v1/timelines/home')) return ok([{ id: '1', url: 'https://masto.example/@aisha/1', created_at: '2026-09-20T10:00:00Z', content: '<p>hi</p>', account: { acct: 'aisha', display_name: 'Aisha', url: 'https://masto.example/@aisha' } }]);
    if (url.startsWith('https://masto.example/api/v1/accounts/lookup')) return ok({ id: '9' });
    if (url === 'https://masto.example/api/v1/accounts/9/follow') return ok({ following: true });
    if (url === 'https://front.example/api/v1/instance' || url === 'https://mei.pod.example/api/v1/instance') return { ok: false, status: 404, json: async () => ({}) };
    return stub(url, init);
  };
  const accounts = fediAccount({ dbName: 'x', fetch: acctStub, storage: undefined });
  const kwame = await accounts.describe('@kwame@masto.example').catch((e) => ({ error: e.message }));
  if (kwame.kind !== 'mastodon' || kwame.host !== 'masto.example') { fail(`a Mastodon address was not recognised: ${JSON.stringify(kwame)}`); bad++; }
  const mei = await accounts.describe('@mei@front.example').catch((e) => ({ error: e.message }));
  if (mei.kind !== 'pod' || mei.root !== 'https://mei.pod.example/anything/' || mei.issuer !== 'https://pod.example/') { fail(`a pod address was not recognised: ${JSON.stringify(mei)}`); bad++; }
  // The Mastodon account acts through its server's API.
  const store = { getItem: (k) => store.m.get(k) ?? null, setItem: (k, v) => store.m.set(k, String(v)), removeItem: (k) => store.m.delete(k), m: new Map() };
  store.setItem('x:masto:account', JSON.stringify({ host: 'masto.example', token: 't', handle: '@kwame@masto.example', name: 'Kwame', actor: 'https://masto.example/@kwame' }));
  const me = await fediAccount({ dbName: 'x', fetch: acctStub, storage: store }).current();
  const posted = await me.post({ text: 'hello' }).catch((e) => ({ error: e.message }));
  const tl = await me.timeline().catch((e) => ({ error: e.message }));
  const followed = await me.follow('@aisha@masto.example').catch((e) => ({ error: e.message }));
  if (me.kind !== 'mastodon' || me.notice !== null || posted.id !== '77' || tl[0]?.author?.handle !== '@aisha@masto.example' || followed.followed !== '@aisha@masto.example') {
    fail(`the Mastodon account did not act through its API: ${JSON.stringify({ posted, tl, followed })}`); bad++;
  }
  // The pod account acts through its outbox door and reads its own records;
  // a sealed key on the pod marks it browser-based, which sets the notice.
  const doorSeen = [];
  const podFetch = async (url, init = {}) => {
    doorSeen.push(`${init.method || 'GET'} ${url}`);
    if (url === 'https://front.example/u/mei/ap/outbox') return { ok: true, status: 202, headers: { get: (k) => (k === 'location' ? 'https://front.example/u/mei/ap/notes/n1' : null) }, text: async () => '' };
    if (url === 'https://mei.pod.example/anything/ap-state/keys.json') return { ok: true, status: 200, json: async () => ({ v: 1, kdf: 'PBKDF2-SHA256', ct: 'x', salt: 'y' }) };
    if (url === 'https://mei.pod.example/anything/ap-state/statuses.json') return { ok: true, status: 200, json: async () => ([{ noteId: 'https://x.example/n/1', actor: 'https://x.example/u/tamara', content: '<p>one</p>', published: '2026-09-20T09:00:00Z', kind: 'timeline' }, { noteId: 'https://x.example/n/2', actor: 'https://x.example/u/tamara', content: '<p>dm</p>', published: '2026-09-20T09:30:00Z', kind: 'timeline', direct: true }]) };
    if (url === 'https://mei.pod.example/anything/ap-state/actors.json') return { ok: true, status: 200, json: async () => ({ 'https://x.example/u/tamara': { preferredUsername: 'tamara', name: 'Tamara' } }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const session = { webId: 'https://mei.pod.example/profile/card#me', fetch: podFetch, signOut: async () => {} };
  const stubWithCard = async (url, init = {}) => {
    if (url === 'https://mei.pod.example/profile/card#me') return { ok: true, json: async () => ([{ '@id': url, 'https://www.w3.org/ns/activitystreams#outbox': [{ '@id': 'https://front.example/u/mei/ap/outbox' }], 'http://xmlns.com/foaf/0.1/account': [{ '@id': 'https://front.example/u/mei/ap/actor' }] }]) };
    if (url === 'https://front.example/u/mei/ap/actor') return { ok: true, json: async () => ({ id: url, preferredUsername: 'mei', name: 'Mei', followers: 'https://front.example/u/mei/ap/followers' }) };
    return acctStub(url, init);
  };
  const podStore = { getItem: (k) => podStore.m.get(k) ?? null, setItem: (k, v) => podStore.m.set(k, String(v)), removeItem: (k) => podStore.m.delete(k), m: new Map() };
  // Reach the pod account the way resume() would, with the session handed in.
  const meiAcct = await fediAccount({ dbName: 'x', fetch: stubWithCard, storage: podStore })
    ._podAccount(session, { handle: '@mei@front.example', actor: 'https://front.example/u/mei/ap/actor', root: 'https://mei.pod.example/anything/' });
  const p2 = await meiAcct.post({ text: 'hello <b>' }).catch((e) => ({ error: e.message }));
  const t2 = await meiAcct.timeline().catch((e) => ({ error: e.message }));
  const f2 = await meiAcct.follow('@tamara@x.example').catch((e) => ({ error: e.message }));
  const doorBodies = doorSeen.filter((s) => s.startsWith('POST https://front.example/u/mei/ap/outbox')).length;
  if (meiAcct.kind !== 'pod' || meiAcct.notice !== BROWSER_ACCOUNT_NOTICE || !p2.queued || p2.id !== 'https://front.example/u/mei/ap/notes/n1'
    || t2.length !== 1 || t2[0].author.handle !== '@tamara@x.example' || !f2.queued || doorBodies !== 2) {
    fail(`the pod account did not act through its door: ${JSON.stringify({ notice: meiAcct.notice, p2, t2, f2, doorBodies })}`); bad++;
  }
  assert.deepEqual(failures, []);
  assert.equal(bad, 0);
});
