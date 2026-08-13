#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
npm run release:verify
npx wrangler pages deploy dist --project-name=spektra-mobile --branch=main
SPEKTRAFILM_E2E_BASE_URL=https://spektra-mobile.pages.dev npx playwright test tests/dng-export.spec.ts -g "auto-rotates portrait DNG pixels and exports them once"
SPEKTRAFILM_E2E_BASE_URL=https://spektra-mobile.pages.dev npx playwright test --config playwright.iphone.config.ts -g "renders a mobile DNG after switching print off and back on"
