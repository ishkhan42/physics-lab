---
doc: prd
status: approved
---

# Mission Board — Product Requirements

A web-based mechanics lab for high-school through university-level students. Mission Board names the main workspace; the final application name is not yet chosen.

Sources: `scope.md > Who It's For`, `scope.md > The Unique Kernel`, and `scope.md > The Core Loop`.

## The Core Journey

1. Open the web app and see a thematic animated introduction.
2. Enter the single-page Mission Board.
3. Describe a mechanics situation in the prompt section, with mechanics as the only active physics category.
4. Interpret the description and check it. Ask a focused question only when missing information would materially change the physical result.
5. Assemble the scene, conditions, parameters, and constants from premade physics building blocks, showing real assembly progress rather than fabricated percentages or agent logs.
6. Present the assembled scene paused, with object cards, initial conditions, assumptions, and a short interpretation summary available for inspection.
7. Start motion only when the student presses Run, then allow playback from 0.1× to 10×.
8. Pause at a chosen simulation moment and inspect the properties of all participating objects in the cards below the canvas, read-only.
9. Keep each ready scene at its own unguessable URL. Refresh or another browser opens the same initial paused setup without another model call.

Source: `scope.md > The Core Loop` and `scope.md > What "Working" Looks Like`.

## Screens and Layout

### Opening Intro

A brief thematic panel entrance leads directly into the Mission Board without a splash gate or delay to typing. Reduced motion bypasses decorative movement. This is an entrance to the lab, not a separate marketing site or additional workflow.

### Mission Board

One main page with these logical sections:

- **Prompt:** the student's description of the scenario.
- **Physics category selector:** mechanics is the only active category for this build. Other categories must not appear functional.
- **Simulation canvas:** the scene and simulated motion.
- **Object cards below the canvas:** every participating object is listed with its properties.

The implementation places the composer beside the canvas on desktop, with object cards directly below the canvas so long interpretations do not bury the measurements. Narrow screens stack the same sections. Provider/category controls remain accessible in a secondary model-settings disclosure.

Source: `scope.md > The POC Boundary`.

## Look and Feel

User direction: physics-lab character, Apple-inspired glassmorphism, and “kintict style UI/UX.”

“Kinetic” interface motion is the working interpretation of “kintict,” not a confirmed product reference. After hands-on feedback, the user requested a brighter appearance: cool light surfaces, dark ink, a restrained teal accent and a light blue-grey simulation canvas. The nonblocking entrance and activity indication yield to reduced-motion preferences.

Apple-inspired glass is an aesthetic reference, not a claim of an official Apple web component system. This is an interactive laboratory workspace, not a marketing landing page; do not introduce pricing, testimonials, scroll-pinned promotional sections, or unrelated decoration.

Accessibility constraints: readable properties and controls over glass surfaces, keyboard-operable controls, clear focus, and reduced-motion treatment for decorative animation. Motion must not obscure scientific state or force a student to follow moving UI to read a value.

Source: `scope.md > Inspiration & Identity`.

## Features and Behavior

### Scenario Prompt and Assembly

The student supplies a scenario rather than choosing only a complete preset. The LLM composes premade physics building blocks and their conditions, parameters, and constants. Scene feasibility and practical cost remain the coverage boundary.

The user approved the assemble–preview–run flow:

- For every omitted physical detail, ask a focused clarification or choose a sensible default explicitly disclosed with its actual value and units. Preserve supplied conditions; do not silently guess consequential ambiguities. Group shared defaults without a long interview about irrelevant quantities.
- Make progress prominent immediately after submitting: indeterminate activity, actual elapsed time and real interpreting/building phases, never fabricated completion percentages or agent-log walls. Stop waiting preserves the draft/preview and returns focus to the editor.
- Arrive at a paused, inspectable scene with populated object cards, visible initial conditions and assumptions, and a short summary of the interpreted experiment.
- Require an explicit Run action; assembly completion does not start motion automatically.
- Make the best meaningful model within the selected physics category. When exact requested behavior is unavailable, a paused approximation must explicitly identify what it does and does not represent, with model choices visible before Run. Never silently replace supplied conditions, fabricate a capability or present an approximation as exact.
- Keep limitation feedback concise and actionable, with technical detail in a disclosure. A question, explanation and supported alternative may coexist without a scene being built. Selecting a proposal fills the draft for review; only a separate Assemble action can request the changed experiment.
- Default to a real physical ground at z=0, not just the reference grid; expose its height and material assumptions. Omit it only for an explicitly groundless/custom-support setup.
- Preserve requested elastic/inelastic collisions and friction. Offer restitution targets, static/kinetic coefficients and contact results rather than removing the requested behavior. Static friction prevents slip, not necessarily rolling motion.
- Replace one-shot scene generation with an integrated Pi lab assistant. It can inspect the mechanics catalog, validate and numerically check candidate scenes, revise them using tool feedback, and accept follow-up requests with the current experiment as context.
- Automatically prepare an enforced sandbox for each run. Permit only trusted Physics Lab tools; deny shell, host files, arbitrary execution, external assets and worker network access. Broker only the selected provider connection outside the sandbox, keeping credentials private. OpenRouter is the default environment-configured provider.

Source: `scope.md > The Unique Kernel` and `scope.md > The POC Boundary`.

### Category Selection

Mechanics is the only active physics category. The selector communicates the category governing the simulation; it must not imply that thermodynamics or other non-mechanics simulations work in this build.

Source: `scope.md > Explicitly Cut`.

### Simulation and Playback

The canvas shows the assembled scene and its simulated behavior. Playback must support 0.1× through 10× and pausing at any simulation moment.

Reset restores the original paused positions and post-impulse velocities, clears queued playback time and reframes the scene without a provider request. Fit view changes only the camera. Speed shortcuts supplement the continuous range control.

Source: `scope.md > What "Working" Looks Like`.

### Saved Scenes

Each scene is saved server-side and shareable by URL, including its source prompt, assumptions and actual physical setup. New records have 24 hours; running/resuming and continuing playback renew retention from server-recorded activity. Opening, copying links and paused view/reset controls do not renew it. Expired URLs are unavailable, while a still-open setup may be saved as a new copy. Ground changes create a separate URL, leaving existing shared records unchanged. This feature saves definitions, not mid-flight state.

Source: user's scene URL and 24-hour retention request.


### Read-Only Object Cards

Cards beneath the canvas list all participating objects and their properties. When paused, their displayed state corresponds to that simulation moment and remains unchanged until the simulation state changes. No object-property editing is included in the initial inspection experience.

Include declared restitution/friction (even zero), linear momentum, translational kinetic energy, uniform-gravity potential, instantaneous contact forces and supported joint spring/damping forces. Do not label these as a complete conserved system energy or net force including every constraint.

The user defines the field-selection rule as “the defining properties of that object in the given context.” Each card exposes the properties relevant to that object, simulation, and physics category rather than a universal field list or a raw engine/debug dump. Physical values must come from the actual model and simulation state, with clear labels and units where applicable; do not fabricate an irrelevant or unmodeled quantity. Exact per-building-block field mappings belong in the technical plan. Dragging, rewind, and historical scrubbing are not implied requirements.

Source: `scope.md > What "Working" Looks Like` and `scope.md > Later`.

## Observable Acceptance Criteria Already Established

- Opening the web app leads through a thematic animated intro into one Mission Board.
- The board contains the prompt section, category selector, and simulation canvas, with object cards below the canvas.
- Mechanics is the only active category.
- A supported student-described scene is assembled from premade physics blocks rather than a fixed complete-experiment menu.
- Missing information that materially changes the experiment triggers clarification before scene readiness.
- A successfully assembled scene is initially paused, with its interpretation, initial conditions, assumptions, and object cards available for checking.
- Motion begins only after the student presses Run.
- An unrealistic request gets the closest scientifically meaningful, explicitly labelled paused model when possible. If no meaningful category model exists, explain the boundary and ask a focused question or offer a reviewable proposal. No invented physical results or silent substitutions.
- Playback supports both endpoints, 0.1× and 10×, and can be paused.
- After pausing, each participating object's properties can be inspected at the paused state without editing them.
- Object cards expose the defining properties relevant to their object and experiment, with values tied to the actual model and simulation state rather than invented fields.
- Saved links survive refresh and server restart, restore paused, and work in a browser with no cached scene or inference credentials.
- Retention is 24 hours from creation or last recorded run activity, with no renewal from reading/sharing and no revival of an expired URL.

These criteria are requirements, not claims of an existing implementation or successful verification.

## Product Decisions

- Web app, not a native application.
- Thematic animated entrance followed by a single main workspace named Mission Board.
- Physics-lab aesthetic combined with Apple-inspired glass and a requested motion style.
- Prompt, category selector, canvas, and object cards form the initial layout; cards belong below the simulation.
- Mechanics only is active.
- This is the initial product design, to be improved through iteration without silently dropping the agreed scope.
- Assemble–preview–run, including consequential clarification, real progress feedback, an inspectable paused preview, explicit Run, and honest unsupported-request handling: the user approved this proposed behavior with “looks good.”
- Context-sensitive object cards: show the defining properties of the object in the given simulation and physics category, not a fixed universal table.

## Approved Conventional Defaults

- Before the first submitted scenario, show an empty canvas and an object-card empty state rather than a fabricated simulation or fabricated object values.
- If assembly fails, keep the student's prompt and show an understandable failure message rather than claiming scene readiness.

These defaults were originally agent-proposed and approved by the user with the completed product definition.

## Deferred From the POC

- Other physics categories, including thermodynamics: the approved scope focuses on mechanics.
- Editing object properties through the inspector: the initial experience is read-only.

## Open Questions

The user approved the completed product definition, including the conventional empty/failure defaults. Continue to technical planning without another product sign-off. Detailed styling and per-building-block property mappings will be resolved in the technical plan and verified during build.

During technical planning: establish feasible physical models and building-block coverage, practical resource limits, and concrete scientific validation cases. No engine or implementation stack is selected here.
