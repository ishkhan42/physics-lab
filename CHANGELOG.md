# Changelog

## Unreleased

- Implement the local Mission Board, real OpenAI/Anthropic/OpenRouter API adapters, current OpenRouter free-model discovery and explicit configuration/error states.
- Compile strictly validated mechanics data to trusted MuJoCo MJCF, then render actual native state in a paused Three.js experiment.
- Add 0.1×–10× fixed-step playback, pause/resume and context-relevant read-only body/connector observations.
- Correct equality-versus-limit constraint lookup, dense/sparse Jacobian interpretation, world/body velocity frames, persistent force/impulse handling and changing native cable-path geometry.
- Bound HTTP bodies and provider responses, reject foreign Host/Origin values, keep keys server-side and prevent built-file paths escaping the distribution directory.
- Verify production building, 43 behavioral regressions and Chromium development/production engine/UI paths. Verify an authenticated `openrouter/free` prompt-to-paused MuJoCo preview and playback; earlier browser assembly fixtures are not product fallbacks. Keep the authorized key in an ignored private file and confirm it is absent from built client assets.
- Redesign the Mission Board as a responsive composer/canvas workbench with secondary model settings, editable prompt starters, focused clarification, visible capabilities, preserved preview context and an honest local stop-waiting action.
- Add native Reset, camera Fit view and speed shortcuts. Reset restores post-impulse initial conditions, clears queued time and reframes the original geometry without recompilation or another model request.
- Spell out complete model-decision alternatives and unsupported restitution behavior; expose bounded schema diagnostics without leaking response values. Verify the reported two-ball request returns a valid limitation response, genuine two-sphere free fall, recovery/focus states and 45 behavioral checks.
- Brighten the complete workbench and actual 3D canvas with cool light surfaces, dark ink and teal controls, including light reduced-transparency fallbacks.
- Show real assembly phases with indeterminate activity, elapsed time and visible local stop-waiting; keep a static active indicator and advancing time under reduced motion.
- Replace raw limitation dumps with concise feedback, optional supported proposals and explicit draft-review consent. Permit useful questions and explanations together without accepting an unresolved scene.
- Require omitted physical details to be clarified or explicitly assumed; improve placement guidance and camera framing so arbitrary infinite-plane patch size does not hide small objects.
- Request JSON-capable free routing, retain strict physical admission and verify the real two-ball proposal-to-native-model journey, cancellation/stale-result safety, narrow-screen focus and all 49 behavioral regressions.
- Replace the earlier unsupported-elasticity policy with real calibrated MuJoCo restitution targets (elastic/partial/inelastic), independent static/kinetic Coulomb friction and preserved torsional/rolling resistance.
- Add a real configurable ground by default, explicitly disabled by `ground:null`, with one canonical rendered/inspectable plane and material assumptions.
- Preserve existing joint/tendon/load composition while substepping collision dynamics, decoupling tangential damping from normal elasticity and respecting native ownership/collision filters.
- Expose material values including zero, momentum, translational kinetic energy, uniform-gravity potential, contact reactions and joint spring/damping forces; do not pretend these are universal total-energy/net-force measurements.
- Verify 62 behavioral references and actual provider-generated elastic/inelastic and static/kinetic scenes, both playback endpoints and Reset. Correct the previous claim that lack of a direct restitution scalar made elasticity impossible.
- Replace JSON-only prompting with provider-native constrained schemas derived from the shared contract; preserve strict semantic/native admission and exact tuple dimensions without prompt-specific aliases or data dropping.
- Bound assembly to two same-model calls total: initial plus validation correction or temporary-service recovery, with real streamed stages, elapsed time, pre-submit charge disclosure and local cancellation. Preserve normal JSON API clients.
- Default to a named schema-capable free model rather than random free routing, and use advertised reasoning budgets to leave room for the actual model definition. Keep model choices explicit and no paid fallback.
- Build meaningful best-effort Mechanics approximations with a prominent review-before-Run notice, while preserving exact represented parameters and declaring missing physics instead of inventing it.
- Refine light workbench contrast, typography, error recovery and narrow/reduced-motion states; keep the reference grid visible above the default ground and avoid empty-canvas help overlap on mobile.
- Encode scene/clarify/unsupported alternatives as native discriminated decision branches inside a strict provider envelope, rather than leaving incompatible metadata to a post-generation prompt rule. Public API decisions remain unchanged.
- Use canonical zero-coordinate generated joint poses, retain physical schema descriptions, and verify actual slider initial position, spring acceleration and Reset through native MuJoCo.
- Require consent before a proposal removes physical ground; recognize existing upward horizontal ground planes so the app does not add duplicate floors.
- Redesign the workbench with one documented visual system: Geist type, a single teal accent, one radius scale, tinted shadows, a dominant canvas stage, a sticky compact composer, scene notes beside the scene, featured x/y/z card readouts with full properties on demand, Phosphor icons and touch-specific canvas hints.
- Replace the blocking ground question with an automatically kept default ground and a local Ground switch; add in-memory session history, Space/R/F shortcuts and an overlay progress card that leaves the previous preview visible.
- Add Motion over time graphs (height, speed, translational kinetic energy) from real solver samples at about 20 per second, with keyboard and pointer readouts and reset with the experiment.
- Give an unsupported verdict one same-model review for a buildable or labelled approximate model inside the existing two-call budget, keeping the original valid verdict if review fails. Give validation corrections the app's own failed physics rules instead of only issue codes.
- Make small, fast and long-range motion visible: trails for moving bodies, fixed-size markers for bodies too small to see, Follow framing that hands control back on manual camera input, and a power-of-ten reference grid and ground patch with a stated square size. Verified on a 300 m/s, 8 km projectile.
- Keep running when a device cannot sustain the selected speed instead of pausing; per-frame browser work is budgeted, queued time is capped, and every fixed physics step is still computed. Fix a frame-loop bug where camera updates could start duplicate animation chains and stall the page.
