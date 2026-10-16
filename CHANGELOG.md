# Changelog

## Unreleased

- Implement the local Mission Board, real OpenAI/Anthropic/OpenRouter API adapters, current OpenRouter free-model discovery and explicit configuration/error states.
- Compile strictly validated mechanics data to trusted MuJoCo MJCF, then render actual native state in a paused Three.js experiment.
- Add 0.1×–10× fixed-step playback, pause/resume and context-relevant read-only body/connector observations.
- Correct equality-versus-limit constraint lookup, dense/sparse Jacobian interpretation, world/body velocity frames, persistent force/impulse handling and changing native cable-path geometry.
- Bound HTTP bodies and provider responses, reject foreign Host/Origin values, keep keys server-side and prevent built-file paths escaping the distribution directory.
- Verify production building, 43 behavioral regressions and Chromium development/production engine/UI paths. Verify an authenticated `openrouter/free` prompt-to-paused MuJoCo preview and playback; earlier browser assembly fixtures are not product fallbacks. Keep the authorized key in an ignored private file and confirm it is absent from built client assets.
