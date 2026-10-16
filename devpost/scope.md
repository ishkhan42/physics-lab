---
doc: scope
status: approved
---

# Mechanics Simulation — Scope

A student describes a mechanics situation, and an LLM assembles premade physics building blocks into an interactive simulation that shows what happens.

## The Unique Kernel

Student-defined scenarios rather than a fixed menu of complete experiments. The LLM assembles scenes, conditions, parameters, and constants; premade physics building blocks supply the simulation behavior. Flexibility comes from composition within a declared physical model.

## Who It's For

High-school through university-level students exploring a mechanics question out of curiosity, checking a proposed solution, or trying to understand a problem visually. Exact university depth and supported mechanics topics remain to be agreed.

## The Core Loop

1. Describe a mechanics situation and its known conditions.
2. Have the LLM assemble the scene using available physics building blocks and the mechanics category's laws, limitations, and assumptions.
3. Run the simulation and observe the outcome.
4. Control playback between 0.1× and 10×. At any point in the simulation, pause and inspect the properties of any object. Inspection is read-only in this build.
5. Explore another condition or scenario to investigate the underlying question.

## Inspiration & Identity

PhysicsHub's simulation catalog (https://physicshub.github.io/simulations) is a reference for interactive visualization, not the desired limit on scene composition. The experience should make studying physics easier, more visual, and more interesting. Detailed visual direction belongs in the PRD.

## Purpose

Help students investigate their own situations, test their understanding or a solution, and see how a physical scenario unfolds. Useful learning and exploration, not animation alone, is the goal.

## What "Working" Looks Like

A student describes a supported mechanics situation, obtains an assembled simulation, and observes its behavior. They can vary playback speed from 0.1× to 10×, pause at a chosen simulation moment, and inspect each object's properties at that state without modifying them. The physical behavior comes from the premade blocks rather than newly invented simulation code for each prompt.

This end-to-end flow is the scope-level demonstration of working behavior. The exact inspected properties and concrete physics validation cases belong in the PRD and technical plan. This draft does not claim universal mechanics coverage or an implemented result.

## The POC Boundary

- Mechanics only, aimed at high-school through university level.
- Student-created scenarios assembled from premade building blocks, not just selection among a few complete presets.
- Explicit category-level physical laws, modeling assumptions, and limitations.
- Scene conditions, parameters, and constants assembled by the LLM.
- Simulation playback covering 0.1×–10×.
- Pause at any simulation moment and inspect the properties of every object at that state, read-only.

The user defines "Any*" as excluding situations that are impossible to model or very expensive. The intended boundary is broad mechanics scene composition subject to modeling feasibility and practical cost, not a small menu of preset experiments. The exact supported models, building blocks, and resource limits require technical feasibility work; this is not a claim that all mechanics scenarios are supported.

## Later

Other physics categories, including thermodynamics. Their eventual existence does not require building a generic multi-category framework in this mechanics project.

Editing object properties through the inspector is deferred: the first build's inspection is explicitly read-only.

## Explicitly Cut

Simulating non-mechanics categories in this build: the selected project focus is mechanics.

## Details for the PRD and Technical Plan

- Define which properties the object inspector exposes for each supported object type.
- Establish supported physical models, building blocks, and practical resource limits through feasibility work.
- Select concrete validation scenarios that check physical behavior as well as the full describe–run–pause–inspect flow.
