#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
npm run release:verify
npx wrangler pages deploy dist --project-name=spektra-mobile --branch=main
VERSION=$(node -p "require('./package.json').version")
curl -fsS https://spektra-mobile.pages.dev/sw.js | grep -F "spektra-mobile-v$VERSION"
SPEKTRAFILM_E2E_BASE_URL=https://spektra-mobile.pages.dev npx playwright test tests/dng-export.spec.ts -g "auto-rotates portrait DNG pixels and exports them once"
SPEKTRAFILM_E2E_BASE_URL=https://spektra-mobile.pages.dev npx playwright test tests/dng-export.spec.ts -g "renders the full-size Leica DNG on desktop without trapping Wasm"
SPEKTRAFILM_E2E_BASE_URL=https://spektra-mobile.pages.dev npx playwright test --config playwright.iphone.config.ts -g "renders a mobile DNG after switching print off and back on"
SPEKTRAFILM_E2E_BASE_URL=https://spektra-mobile.pages.dev npx playwright test --config playwright.iphone.config.ts -g "keeps every Leica renderer and output format inside the iPhone memory budget"
