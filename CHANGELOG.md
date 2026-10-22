# Changelog

## Unreleased
- Redesign the workspace around the simulation: a full-height stage with a floating play bar (Run/Pause, Reset, time, speed menu) and icon view controls, and one side panel that reads as a conversation, then the scene summary, motion graph and objects, with the message box pinned below. Settings, link sharing and the capability notes move into top-bar menus; the physical Ground switch moves next to the scene facts.
- Show the prepared examples on the empty stage, add three starter prompts, keep assumptions visible, and list objects compactly: identical fixed parts are grouped, a selected object shows speed, height, mass and kinetic energy, and solver noise below 0.1 mm or 0.1 mm/s reads as 0 outside "All values".
- Show all five prepared examples in the README with labeled, consistently sized five-second GIFs sampled from native simulation states.
- Replace the README's development log with usage, local setup, architecture and limits; add GIFs recorded from real pendulum and spring-net playback.
- Record final acceptance of the contest POC and update the technical app map. Submission materials remain separate.
- Default the reference grid off when unspecified, preserving explicit saved choices and the independent physical ground.
- Withdraw the experimental body-force overlay and its native decomposition after visual review; retain the existing native spring/tension visuals and numeric mechanics readouts.
- Replace the four rejected study families and their variants with spring-net impact, three-body choreography, a frictionless contact-loss loop and a curved domino cascade. Retain the double pendulum with a measured 5° difference in its actual upper-link poses, not just its description.
- Show cropped native-simulation frame previews in a compact responsive example gallery, with complete standalone prompts and no inference required to open a setup. Keep existing saved copies unchanged.
- Rehearse every study through native dynamics and browser playback; add regressions for spring energy return/scheduled release, impact losses without friction, orbital near-return/center-of-mass stability and cascade propagation. Make renderer readiness use the first bundled scene rather than a retired example ID.
- Add an explicitly authorized public hosted GPT-6 Luna High demo with a fixed expiry and a separate renewable OAuth session in Secret Manager. Remove Basic Auth and password configuration; retain exact expiry, bounded requests and free-only OpenRouter alternatives without automatic fallback.
- Verify the original elastic/inelastic two-ball prompt through the real hosted subscription, visual inspection, independent review, saved-scene playback and refresh; add admission, token-lifetime and exact-expiry regressions.
- Serialize credential rotation with a durable lease, persist rotated credentials before use, and finish in-progress rotation after browser cancellation without exposing credentials to the browser, agent or saved scenes.
- Add a hosted API mode with explicit HTTPS origin admission, free-only OpenRouter routing and zero upstream token-price ceilings; keep local provider choices and loopback defaults unchanged.
- Persist hosted scenes in Firestore with bounded JSON chunks, immutable links, exact logical expiry and transactional renewal/cleanup. Preserve the local private SQLite store.
- Connect the trusted broker to a private authenticated Docker gateway without moving provider credentials into the worker. Keep the existing sandbox limits, stream budgets and independent review.
- Build API, worker and keyless renderer targets from one Dockerfile. Qualify agent isolation/native motion on the private VM and actual scene rendering before the renderer becomes ready; use a bounded inspection RPC without giving the agent network or browser-command access.
- Isolate malformed model-catalog rows, support current routing aliases, preserve required single-tool review across free endpoints, and request low reasoning only from models that support it. Distinguish unavailable provider routes from scene errors and bound generated content separately from repeated SSE transport metadata; never retry or add a paid fallback.
- Render actual tendons as shaded round-wire springs and detailed cords, with native signed tension/compression arrows and schematic slack. Existing scenes receive the visuals automatically.
- Expose optional model-facing wire radius, coil radius, winding count and relative-force reference without changing mechanics or native-check fingerprints. Image inspection uses the same geometry and refreshes when the style changes.
- Follow native sphere/cylinder wrapping, preserve routed anchors, and reuse geometry/bounds buffers. Keep compound connectors selectable and GPU-resource disposal explicit.
- Provide a bundled library of five prepared mechanics studies. Explicit **Open setup** saves a new immutable paused copy without model inference or provider credentials; **Start from prompt** fills a fresh editable draft without saving or sending it. Ordinary AI composition and its real failure handling remain unchanged.
- Keep example actions available during background expiry renewal and prevent late replies from undoing a new draft. Native dialog keyboard handling preserves the underlying selection and draft on cancellation.

- Polish the light workbench without replacing its visual system: remove repeated welcome/category text, collapse recent scenes and defer empty charts/cards until an experiment exists.
- Improve conversation readability, reduce the desktop viewer's height, enlarge touch targets and use 16px narrow-screen form text.
- Shorten static progress/playback/sharing copy, distinguish “Use as draft” from accepting a checked proposal, correct singular object counts and request direct plain-text model summaries without promotional filler or forced second-person wording.

- Surface the existing Devpost Learn Skill Pack artifacts near the top of the README, with direct planning/build/map links, the first implementation checkpoint and explicit unfinished readiness status; remove the buried duplicate.

- Prepare the current app for authorized public source release with an MIT application license, preserved third-party notices and an offline technical app map. Keep technical verification separate from the learner's final readiness confirmation.
- Verify a clean dependency install, production/inspection/Docker builds and 182 behavioral checks; strengthen the real isolated-renderer regression to compare texture on/off on the same material.
- Add a saved Reference grid switch under Appearance / Guides, defaulting on for older records and remaining independent of the physical ground.
- Cooperatively yield between calibrated native contact substeps, preserve pending-step/event/reset state and coherent partial observations, and accept real time progress in readiness checks even when no whole millisecond has completed.
- Stop mistaking long foreground physics/render work for a suspended browser gap. Preserve genuine idle/hidden-tab and numerical-safety guards.
- Batch distant markers, restore detailed geometry on focus/zoom and skip only subpixel drawing while retaining bodies, picking, bounds and recorded trajectories.
- Render inspector detail rows only when opened; retain distinct chart samples while coalescing chart redraws and avoid full observation solves after every tiny partial handoff.
- Add locally bundled CC0 4K ground color textures with 2K normal/roughness detail, physical-scale repetition, six curated surface choices and four coordinated sky/lighting presets. Load only selected materials and cap small-screen GPU resolution.
- Add an accessible visual Appearance picker, a texture-only switch independent of the ground collider, and immutable saved appearance links without AI calls or simulation resets. Preserve previous links, recover unsaved looks, report missing assets honestly and refresh model screenshots when the look changes.
- Open paused previews after native initialization, a short motion warm-up and independent review, rather than blocking on an arbitrary frame checklist or the whole scheduled future.
- Stop forwarding repeatedly growing SDK partial-message snapshots through the sandbox pipe; send lifecycle bookends once while streaming bounded public assistant text separately.
- Distinguish a missing sandbox image, Docker startup, worker/protocol, resource and transport-limit failures instead of advising a sandbox rebuild for every exception.
- Accept bounded declarative body grids in AI authoring, expand them into ordinary independent bodies before validation, and report the actual remaining capacity including ground.
- Measure straight-cord vertical projections and angles separately from native path lengths; disclose signed regularization residuals, shared moving junctions, positive junction-mass approximations and initial force observations without inventing a universal acceptance tolerance.
- Let supported, settled, frictional free boxes enter native automatic sleep without changing solver/contact parameters; protect driven, constrained, lossless and explicitly moving bodies, require renewed equilibrium after waking, and fully rearm on Reset. Omit stale resting and incomplete fixed-support contact-force readouts.
- Keep cords and constraint links readable on the light canvas by bounding display luminance while preserving their hue and saved colors.
- Add a builder-only, bounded arithmetic/trigonometry tool instead of relying on model mental math; expose named finite results without expression evaluation or I/O.
- Ground review in chronological native motion checkpoints, declared launch speed/frame-specific angles and oriented-box world bounds. Distinguish contact from penetration, post-impact motion from initial instability, and overview resolution from missing geometry.
- Keep bounded concrete review diagnostics instead of replacing every long finding with a generic mismatch; preserve native deadline details through the safe error contract.
- Frame complete authoring, tool-result and review JSON into bounded ordered text blocks, preserving Unicode and all measurements; prevent a valid large repair review from crossing a single-block limit while retaining overall safety caps.
- Give check/finish/inspection tools the actual typed decision schema instead of JSON-in-a-string arguments; preserve tuple/cardinality and aggregate size guards with no legacy alias.
- Allow diagnostic initial-state measurements and real screenshots before a future motion check succeeds; retain strict full-check/review gates for finalization and cache unchanged native failures within a run.
- Losslessly table-encode repeated native measurement descriptors and record columns; keep runtime/card/save formats unchanged.
- Initialize kinematics and inertia through MuJoCo’s staged pipeline, avoiding repeated intermediate force solves while retaining final initial-state checks.
- Keep any nonnegative frame available for on-demand image inspection, bounded by capture/native-stability limits rather than an arbitrary 20-second horizon.
- Give both model roles current remaining request, lab-action, inspection and image-attempt allowances, including final-review reserves and per-review format attempts.
- Keep initial-check coverage in the completed update's expandable activity, without extra verification controls or new claims on old saved links.
- As a last resort after exhausted concrete AI review disagreement, offer the real native-checked proposal for an explicit user decision. Keep it unsaved and separate from the last good experiment until acceptance; native/provider/cancel/unusable-review failures never become proposals.
- Use calm, nontechnical review choices and preserve ordinary approved builds without an extra confirmation step.

- Raise the default to 16 total AI requests with final-review capacity reserved, keeping the 24-tool, four-minute and two-concurrent-run boundaries.
- Enforce native reviewer verdict-tool choice at the provider boundary, validate builder/reviewer scope and bound unusable-verdict correction to two review requests without physical-repair loops or approval fallbacks.
- Preflight review capacity before expensive finalization and distinguish unstarted, unusable and unresolved rejected reviews.
- Show compact Build/Test/Review activity, actual request/limit counters, elapsed time, accessible Stop and terminal activity receipts in the light chat; preserve drafts/preview, reset fresh-request counts and avoid fake completion percentages or raw reasoning.
- Require a declared lab action from builder model requests too, preventing narration-only loops while still allowing structured clarification/limitations; keep the last concrete validation issue when reserved capacity is exhausted.
- Match the pinned Anthropic SDK’s exact beta-messages inference URL without widening the broker to arbitrary targets or queries.
- Share scheduled/carried-body semantics with both agents and expose initial native carrying/release relationships in structural evidence; clarify ball-joint reference-origin constraints and conditional provider token limits without changing stored scene data.

- Fix incorrect fixed-support Position measurements caused by reading a massless body's inertial center instead of its physical world origin; preserve moving-body COM/energy measurements.
- Give builder/reviewer one authoritative coordinate-conventions source and native measured joint geometry; provide the decision schema upfront instead of requiring a catalog turn.
- Let the builder answer a rejected finding with a bounded correction or evidence-backed rebuttal, and give the next reviewer both claims plus the authoritative schema; preserve native validation, independent approval and existing request limits.
- Allow strict physical repair/review to complete after the bounded screenshot allowance is used, with explicit missing-image disclosure and no stale-frame substitution.
- Distinguish transport/protocol/provider-overload errors from bad physics, including overload events inside HTTP200; preserve bounded future activity-stage compatibility without weakening final scene admission or adding automatic retries.

- Add actual-renderer visual inspection only for selected models advertising image input; omit the tool and images for text-only or unknown-capability models without switching models.
- Render bounded deterministic times/views inside the isolated sandbox, show “Looking at your scene” activity and send real JPEG blocks to the builder and independent reviewer before handoff.
- Keep screenshot capture asset-only and network-isolated, validate multimodal content at the broker, bound browser resources/capture budgets and preserve saved scenes on failure.

- Fix a reproducible finish loop where cosmetic title changes invalidated checks until the model budget was exhausted. Accept independently approved scenes directly instead of requiring identical resubmission; reuse numerical checks across cosmetic/metadata edits.
- Preserve bounded failure cause, stage, model/tool counts and safe last-check information through worker, broker and UI, with flushed terminal records and credential-safe logging.
- Add measured initial contact/penetration, structural support/coupling and sampled motion/rotation evidence. Independently review model fidelity against intent, rather than treating a successful simulation as proof of the requested mechanism.
- Expose the complete reviewer verdict schema as native tool arguments, reject malformed/contradictory verdicts, and count review calls within existing budgets.
- Draw true native hinge/ball reference links without fake massive rods, extra constraints or accidental selection targets. Keep the original saved definition when creating a corrected scene.

- Add click/tap selection for scene objects and cable paths, including tiny-object marker hits, a visible outline and synchronized inspector selection.
- Add Focus, Follow, Values and Clear controls plus a keyboard-accessible object chooser. Follow a queued object when it launches; orbit/zoom stay attached, while panning releases the camera.
- Keep selection view-only and local: no physics edits, inference or scene/lease writes; Reset and scene replacement restore the overview. Distinguish clicks from drags/multitouch and preserve ordinary keyboard activation.

- Add general one-shot schedules for impulses, continuous-load toggles and carried-body release/launch. Preserve counts/timing, input order for ties, native-boundary precision and exact Reset/replay; old saved definitions remain untouched.
- Model carried mass/inertia and momentum-conserving recoil in the trusted runtime, including post-recoil relative launch speed and inherited carrier motion. Suppress carried collisions/visuals until activation, then restore full contacts; clear hidden trails and exclude held objects from framing.
- Replace technical agent log walls with compact expandable chat, plain activity and a visual action storyboard showing real completion, mass/speed and native loaded inventory. Keep original saved requests available without forcing users to rewrite them.
- Preserve original human context and assumption provenance across refreshes, supply solver-measured initial state to Pi, and require check-report review before accepting a newly proposed scene.
- Add explicitly authorized Connected GPT mode for GPT-6 Luna via a broker-side OMP token command. Pin the credential per run, force guarded SSE and leave sandbox credential/network/file denial unchanged. OpenRouter stays the default when this mode is off.

- Replace one-shot provider-envelope assembly with an integrated Pi agent loop and three lab-only tools: inspect the catalog, validate/smoke-simulate a candidate, and finish a checked decision. Validation feedback can drive multiple revisions without prompt-specific cases.
- Automatically build/cache a disposable Docker sandbox on application startup. Deny worker networking, host mounts, credentials and shell/file tools; use non-root/read-only/capability-dropped/resource-limited execution and bounded stdin/stdout model brokering.
- Keep provider connections inside the Pi server broker, with OpenRouter preferred from the private environment, fixed selected-model HTTPS endpoints, redirect denial, bounded streaming and no hidden provider retries or paid fallback.
- Add scene-aware conversational follow-ups, bounded tab-local history, coalesced public assistant activity, actual model-turn/catalog/check progress and an explicit eight-turn/four-minute spending limit. Preserve drafts and old previews on failure; save successful changes as new paused scene links.
- Preserve the exact checked scene through preview preparation, including explicitly groundless setups, instead of silently re-adding ground. Omitted ground still receives the shared default.
- Exercise the real isolated Pi loop, invalid-model repair, forbidden-tool denial, numerical projectile checks, run limits, cancellation and private-scene contracts. Real OpenRouter/browser checks exercised unequal-mass elastic/inelastic drops and a height-only follow-up; a provider HTTP502 remained an honest recoverable failure.

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
- Save validated scene definitions privately in SQLite with unguessable URLs, refresh/shared-browser restoration, copy links and visible expiry. Restore the initial paused setup without another model request, not a mid-flight snapshot.
- Apply a 24-hour sliding lifetime from creation or last recorded Run activity; active playback and final Pause renew it, while opening, sharing and paused view controls do not. Exact-boundary expiry cannot resurrect, and expired rows are purged automatically.
- Keep shared definitions immutable: ground edits and expired local copies receive new links. Persist only recent-link metadata in the browser; preserve captured setup recovery on save failures and prevent stale lease replies from replacing newer activity.
