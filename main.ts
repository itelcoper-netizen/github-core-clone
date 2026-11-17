// main.ts — entrypoint for the github-core-clone-01 forge.
//
// Trial lifecycle, written for this entry:
//   1. Start the forge on an ephemeral port (never a fixed one, so the trial
//      can run several instances side by side).
//   2. Tell the trial environment which port we bound, via
//      POST $MAKEFUN_ENV_URL/register {"port": <n>}.
//   3. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then
//      exit 0. The trial drives all grading through HTTP while we wait.
//
// Without MAKEFUN_ENV_URL there is no trial to talk to, so we exit 1.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;

if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set; nothing to register with.');
  process.exit(1);
}

const { server } = createApp();

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  void registerAndWait(port);
});

async function registerAndWait(port: number): Promise<void> {
  const register = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!register.ok) {
    console.error(`register failed: HTTP ${register.status}`);
    process.exit(1);
  }

  // The trial flips /done to true when grading is finished. Poll it
  // patiently; the server keeps answering requests the whole time.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let done = false;
    try {
      const res = await fetch(`${envUrl}/done`);
      const payload = (await res.json()) as { done?: boolean };
      done = payload.done === true;
    } catch {
      // A transient environment hiccup must not kill the forge; retry.
      continue;
    }
    if (done) break;
  }
  server.close(() => process.exit(0));
}
