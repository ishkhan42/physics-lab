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

“Kinetic” interface motion is the working interpretation of “kintict,” not a confirmed reference to a particular product or design system. The implementation uses graphite surfaces, a restrained cyan accent, frosted panels, system typography and a brief nonblocking entrance; motion yields to inspection and reduced-motion preferences.

Apple-inspired glass is an aesthetic reference, not a claim of an official Apple web component system. This is an interactive laboratory workspace, not a marketing landing page; do not introduce pricing, testimonials, scroll-pinned promotional sections, or unrelated decoration.

Accessibility constraints: readable properties and controls over glass surfaces, keyboard-operable controls, clear focus, and reduced-motion treatment for decorative animation. Motion must not obscure scientific state or force a student to follow moving UI to read a value.

Source: `scope.md > Inspiration & Identity`.

## Features and Behavior

### Scenario Prompt and Assembly

The student supplies a scenario rather than choosing only a complete preset. The LLM composes premade physics building blocks and their conditions, parameters, and constants. Scene feasibility and practical cost remain the coverage boundary.

The user approved the assemble–preview–run flow:

- Resolve consequential ambiguity with a focused question; cosmetic details must not turn every prompt into a long interview.
- Communicate real assembly progress without fabricated percentages or a wall of agent logs.
- Arrive at a paused, inspectable scene with populated object cards, visible initial conditions and assumptions, and a short summary of the interpreted experiment.
- Require an explicit Run action; assembly completion does not start motion automatically.
- Explain unsupported requests honestly. Do not substitute another experiment, silently simplify the model, or invent a result. A proposed simpler model requires the student's agreement.

Source: `scope.md > The Unique Kernel` and `scope.md > The POC Boundary`.

### Category Selection

Mechanics is the only active physics category. The selector communicates the category governing the simulation; it must not imply that thermodynamics or other non-mechanics simulations work in this build.

Source: `scope.md > Explicitly Cut`.

### Simulation and Playback

The canvas shows the assembled scene and its simulated behavior. Playback must support 0.1× through 10× and pausing at any simulation moment.

Reset restores the original paused positions and post-impulse velocities, clears queued playback time and reframes the scene without a provider request. Fit view changes only the camera. Speed shortcuts supplement the continuous range control.

Source: `scope.md > What "Working" Looks Like`.

### Read-Only Object Cards

Cards beneath the canvas list all participating objects and their properties. When paused, their displayed state corresponds to that simulation moment and remains unchanged until the simulation state changes. No object-property editing is included in the initial inspection experience.

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
- An unsupported request produces an explanation, not a fabricated result or an unapproved replacement experiment.
- Playback supports both endpoints, 0.1× and 10×, and can be paused.
- After pausing, each participating object's properties can be inspected at the paused state without editing them.
- Object cards expose the defining properties relevant to their object and experiment, with values tied to the actual model and simulation state rather than invented fields.

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
