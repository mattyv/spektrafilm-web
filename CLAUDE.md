# Development rules

## Test-driven development is mandatory

For every bug fix or behavior change:

1. Write the smallest automated test that reproduces the bug or specifies the behavior.
2. Run it and record that it fails for the expected reason.
3. Make the smallest production change that passes it.
4. Run the focused test, then the relevant unit, browser, WebKit, and Rust suites.

Never write production code first. A test that only passes after the fix is not evidence of TDD. Do not weaken, delete, skip, or rewrite a failing test merely to make CI green.

Use unit tests for pure logic and Playwright for real user flows. Image-processing controls must be tested by rendering the repository's stock image with fixed settings and comparing output pixels or deterministic hashes. Test Reference and Fast GPU modes, every output format, before/after, metadata orientation, batches, opening replacement/additional files, and mobile/WebKit paths where affected.

## Coverage gate

All code added for this web project on top of the upstream `turbasvin/spektrafilm-rs` fork must maintain 100% line coverage. This includes `web/src` executable TypeScript and the added `crates/spektrafilm-web` Rust crate. Generated WASM bindings, vendored/upstream code, declarations, and non-executable CSS/assets are excluded.

CI must fail below 100%; do not use coverage-ignore comments unless the line is provably unreachable platform glue and the reason is documented beside it.

## Definition of done

A change is not done until its failing test has been observed, the fix passes, coverage remains 100%, the production build succeeds, and the affected desktop plus iPhone/WebKit user flow passes. Do not deploy a failing or untested build.
