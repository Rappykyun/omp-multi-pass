# Changelog

## 1.5.1-omp.1

- Port the Codex account features of pi-multi-pass 1.5.1 to native omp 18.6.1.
- Use `omp.extensions`, native provider registration, native OAuth login and refresh, and the active-profile credential store.
- Keep subscriptions, pools, four selection strategies, quota inspection, project restrictions, and optional routing traces.
- Retry accounts at the provider-request boundary. Do not resubmit the user's prompt or retry after text, reasoning, or tool-call output.
- Treat an empty project account allow-list as deny-all.
- Validate configuration before atomic replacement. Keep malformed files unchanged.
- Keep account routing and cooldown state separate for each extension factory.
- Use live native chat model catalogs with image-input metadata.
- Remove other providers, cross-provider chains, presets, Pi compatibility code, and copied/source-text test harnesses.
- Add native behavior checks and actual omp CLI smoke checks with a local fault-injection server.

Real OAuth authorization and real Codex text/image requests were not tested. The user chose to skip these checks.
