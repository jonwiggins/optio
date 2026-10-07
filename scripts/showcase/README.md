# Optio example workspace and product captures

The product tour uses real Optio web, SwiftUI, and Jetpack Compose screens with
fictional demonstration data. Session activity, historical results, and usage
figures are illustrative, not claims about actual agent runs. Apple glance images
come from the production SwiftUI components rendered by `WidgetSnapshots`; the
Dynamic Island layout is a component preview, not a photograph of a device.

## Add examples to a local deployment

From the repository root, with the normal Docker Desktop deployment running:

```bash
node scripts/showcase/seed.mjs --local
```

This explicitly targets Kubernetes context `docker-desktop`, namespace `optio`,
and the bundled `optio-postgres` deployment. It requires the local API on port
30400 with authentication disabled. It is not a production seeder.

It adds:

- 12 saved definitions covering all nine trigger types and all seven agent runtimes,
  plus a shell command and a local automation;
- three paused persistent-agent specialists;
- six completed, clearly labeled sample runs;
- three recorded sessions with example conversations and terminal output;
- an offline example machine with a fictional `/workspace/storefront` directory.

All local names begin with **Example ·**. Search for **Example** in Work and use
Recurring, Agents, or History to explore. All triggers and definitions are disabled,
and agents are paused. Nothing is queued, no external message is sent, and no real
agent or shell runs. The script creates no local credentials or integration accounts.

Rows use stable IDs and inserts run in one transaction. Re-running skips existing
rows, preserving edits and avoiding duplicates. The script does not reset examples
that you later enable. To make one real, review its prompt, replace placeholder
filters and destinations, select the correct credentials, and enable it deliberately.
Delete unwanted examples through the app. Your existing work is not changed.

## Capture the product tour

Use a separate private dev lab to keep personal work out of public screenshots.
The API is real; its container runtime and the playback daemon are simulated.

```bash
bash apps/android/scripts/test-api.sh start --port 4965 --no-seed
node scripts/showcase/seed.mjs --lab 4965
node scripts/showcase/playback.mjs 4965
```

The lab seeds dummy, nonfunctional setup keys in its own database. Definitions show
as armed for the tour, but all trigger rows remain disabled. The playback process
speaks the real Local WebSocket protocol and holds three simulated sessions open;
it executes no commands. Keep it running during capture, then stop it with Ctrl-C.

Run a built web image against this lab on a separate port (substitute an image built
from the current checkout):

```bash
docker run --rm --name optio-showcase-web \
  -p 127.0.0.1:30311:3000 \
  -e HOSTNAME=0.0.0.0 -e OPTIO_AUTH_DISABLED=true \
  -e INTERNAL_API_URL=http://host.docker.internal:4965 \
  -e PUBLIC_API_URL=http://localhost:4965 \
  optio-web:latest
```

In another terminal:

```bash
node scripts/showcase/capture-web.mjs
```

Build and install the native **Debug** apps using the [iOS](../../apps/ios/README.md)
and [Android lab](../../apps/android/e2e/README.md) instructions. Start an iPhone
simulator and Android emulator, then:

```bash
OPTIO_SHOWCASE_SIMULATOR=<simulator-uuid> \
OPTIO_SHOWCASE_EMULATOR=emulator-5562 \
node scripts/showcase/capture-mobile.mjs
```

The script uses debug launch options to connect both apps to port 4965 and capture
Work, Recurring, a conversation, and New work, plus the iOS Overview. It never installs onto or changes a
physical phone. Raw PNGs go to `/tmp/optio-showcase-shots`.

For the Apple component sheet, run
`WidgetContactSheetTests/testProductGalleryGlances` under the `WidgetSnapshots`
scheme. Copy the simulator output `optio-widget-shots/product-glances-dark.png` to
`/tmp/optio-showcase-shots/ios-glances.png`.

```bash
# Install cwebp with your package manager if needed.
node scripts/showcase/optimize.mjs
node scripts/showcase/capture-social.mjs
```

The canonical WebP assets and a provenance manifest live in
[`apps/site/public/screenshots/showcase`](../../apps/site/public/screenshots/showcase/).
The README references that same directory. Inspect every capture before publishing;
verify that loading, setup, or permission screens were not captured by mistake.
The social-card script composes `apps/site/public/og-image.png` from the Overview
capture and the Optio wordmark.

When finished, stop the playback process, the showcase web container, and only the
lab/emulator you started:

```bash
docker stop optio-showcase-web
bash apps/android/scripts/emu.sh stop emulator-5562
bash apps/android/scripts/test-api.sh stop --port 4965
```

Do not restart or stop the user's normal Optio Local daemon. The paused examples in
the normal local deployment remain available independently of this lab.
