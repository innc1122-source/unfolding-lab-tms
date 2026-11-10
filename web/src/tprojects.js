import { api } from './api.js';

// One shared fetch for "my training projects" so TopBar, MobileTabBar and Home
// don't each hit the API on every mount. 30s soft cache; force to bypass.
let cache = null;
let at = 0;
let inflight = null;

export function fetchMyProjects(force = false) {
  if (!force && cache && Date.now() - at < 30000) return Promise.resolve(cache);
  if (!force && inflight) return inflight;
  inflight = api.get('/api/me/tprojects')
    .then((d) => { cache = d; at = Date.now(); inflight = null; return d; })
    .catch((e) => { inflight = null; throw e; });
  return inflight;
}

export function clearMyProjectsCache() { cache = null; at = 0; }
