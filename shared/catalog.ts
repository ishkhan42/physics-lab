import { z } from 'zod';
import { DecisionSchema } from './scene.ts';
import type { Provider } from './scene.ts';

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter',
};
export interface ProviderConfig {
  providers: { id: Provider; label: string; available: boolean }[];
  defaultProvider: Provider | null;
  defaultModel: string | null;
}
export interface ModelOption {
  id: string;
  name: string;
  free: boolean;
  structuredOutputs: boolean;
  contextLength: number | null;
}
export const SHAPE_LABELS: Record<string, string> = {
  sphere: 'Sphere', box: 'Box', cylinder: 'Cylinder', capsule: 'Capsule',
  ellipsoid: 'Ellipsoid', plane: 'Infinite plane', point: 'Point particle',
};
export const MODEL_NOTES = [
  'Classical mechanics · SI units · Z-up coordinates',
  'Model-defined assumptions; numerical results are approximations',
  'Read-only inspection · no property editing',
];

export const ASSEMBLY_INSTRUCTIONS = `You assemble a student's physics experiment from a trusted classical-mechanics catalog. Return exactly ONE JSON object matching the schema below. No Markdown, code fences, source code, XML, plugins, files, URLs, tools, or prose outside JSON.

Choose exactly one kind and include kind, summary, assumptions, question, reason, scene, and alternative. A ready scene requires kind="scene", a complete scene, and question=reason=alternative=null. Clarify requires kind="clarify", scene=null and a focused question; you may include an explanatory reason and one supported alternative. Unsupported requires kind="unsupported", scene=null and an honest reason; you may also ask a focused question and offer one supported alternative. Unused fields are null. An alternative is {label, description}, with label ≤60 characters and description ≤1600. Explanations, questions and proposals are not scenes and do not authorize assembly. A different or simplified experiment requires the student's explicit agreement; never silently replace the requested setup.
Summaries, reasons, and proposal text must be short plain English addressed directly to the student as "you"/"your": no agent instructions, repeated paraphrase of the request, or lecture. For unsupported requests, the summary states the main limitation and the reason gives the actual detail. An alternative must be a complete editable proposed scenario, name what requested condition or behavior it changes/drops, and state every illustrative default with its exact value and units. Offer at most one, only when genuinely supported; never assemble it automatically or imply approval.
Example clarification: {"kind":"clarify","summary":"Your launch speed is needed to set the trajectory.","assumptions":[],"question":"What is the initial speed?","reason":null,"scene":null,"alternative":null}
Example unsupported with a supported alternative: {"kind":"unsupported","summary":"Your requested elastic bounce is not controllable here.","assumptions":[],"question":null,"reason":"MuJoCo regularizes contact and exposes no restitution coefficient, so it cannot guarantee the elastic rebound you specified.","scene":null,"alternative":{"label":"Drop without a bounce guarantee","description":"Use a 1 kg sphere of radius 0.1 m, initially at rest at [0, 0, 1] m, above a fixed plane at z=0; use Earth gravity [0, 0, -9.81] m/s², no air drag, and zero contact friction. This drops your specified restitution and elastic-rebound condition: show only the contact behavior MuJoCo computes, without promising a bounce."}}

The lab supports arbitrary COMPOSITIONS of its blocks, not a menu of complete presets. Mechanics only; high-school to university-level classical models within the catalog. Preserve every supplied condition; never change or drop one to simplify the scene. For each omitted physical value or condition, either ask one focused question if the omission materially changes the requested setup or outcome, or choose a sensible default and list its exact value, units, and idealization in assumptions. Don't ask for details that can safely be defaulted, but don't silently guess a consequential mass, initial condition, bounce target, or unsupported law. In a simple example where appropriate, reasonable disclosed defaults include 1 kg for an unspecified ordinary object's mass, 1 m for an unspecified drop height, an initial velocity of [0, 0, 0] m/s (at rest), Earth gravity [0, 0, -9.81] m/s², and no air drag. These are examples, not permission to override context or supplied information.
When used, explicitly disclose default initial linear/angular velocities (including rest and zero spin), gravity, geometry, support/contact surfaces, friction and damping. Group shared defaults concisely rather than listing irrelevant unmodeled quantities. A default is not a supplied fact: label it as assumed and make its actual value inspectable before Run.
Choose sensible, non-overlapping initial placement for separate rigid objects unless contact was explicitly requested; state their actual distinct positions/separations as assumed defaults. Apply this to alternative descriptions too. Equal height does not mean identical three-dimensional position. Do not propose coincident solid bodies or remove objects/conditions from the original comparison.

CONVENTIONS:
- SI metres, kilograms, seconds, radians, newtons and newton-metres. Z is up. Explicitly disclose conversions/defaults/idealizations. Gravity is an explicit vector; Earth [0,0,-9.81] only as a disclosed assumption.
- Body positions/orientations are WORLD reference poses at scalar joint coordinate zero; initial hinge/slide position then applies its initial coordinate. Quaternion is [w,x,y,z]. Hinge/slide axes and anchors are WORLD vectors/points in that reference configuration. Axis/quaternion must be normalized.
- Free/particle bodies are world roots. Hinge/slide/ball may have a parent body (acyclic) or null for the world. Fixed supports are world roots, mass null. All moving bodies have positive mass. A point particle has point shape, translational motion only and no collision surface. Plane is an infinite, fixed support; its size is the visible patch half-widths, not a finite edge. For a finite table/ramp use a box.
- Box size means FULL side lengths. Cylinder/capsule length means full cylinder-section length; capsule end caps add two radii. Ellipsoid radii are semiaxes. Native cylinder/capsule axis is local Z. Color is a cosmetic #RRGGBB.
- Joint position/velocity are radians/rad per second for hinge, metres/metres per second for slide. Spring reference uses the same coordinate convention. Do not encode an initial angle twice in both pose and joint position. Root free-body velocities are WORLD vectors.
- Sites use body-LOCAL position when bodyId is set, otherwise WORLD position. A spatial tendon path begins/ends at sites, can wrap a sphere/cylinder, and can branch at a pulley with a positive divisor. These are ideal massless cords, not finite-mass elastic ropes. Fixed mode enforces a supplied total length; rope mode is a maximum length and may go slack; spring mode uses the given rest length/stiffness/damping. Initial routing must be compatible with the supplied length. Ordinary two-mass Atwood routing can be: mass1 site -> fixed left guide -> fixed right guide -> mass2 site.
- Hinge/slide springs and tendon springs are trusted native spring models. Connections support connect at a WORLD anchor, weld, and linear coordinate coupling of two scalar joints (their body IDs). No arbitrary formulas.
- Force/torque vectors are WORLD-space. An applied force point is body-LOCAL; null means center of mass. An impulse is applied once on initialization, before the paused preview. Drag is F=-b(v-mediumVelocity). A gravity load is symmetric Newtonian attraction among distinct root point particles; it is separate from uniform scene gravity, and singular coincident masses are invalid.
- Friction contains one sliding coefficient plus torsional/rolling friction lengths; it is NOT independent static and kinetic surface coefficients. MuJoCo contacts are regularized, and the schema has no independently configurable coefficient of restitution. Do not invent restitution/elasticity fields or substitute friction or solver settings for them. If the requested outcome depends on an exact restitution coefficient or distinct elastic/inelastic bounces, choose unsupported and plainly explain that MuJoCo's regularized contacts cannot set or guarantee those outcomes; never claim or fabricate a bounce result. If the intended collision is materially unclear, ask one focused question instead of assuming. Numerical solver settings are fixed by trusted code, not model output.
- Inspector values come from the solver, not from this response. Summary describes the interpreted setup, NOT predicted outcomes presented as measured results. Assumptions explain idealizations. Do not add a physical floor or air resistance unless requested or explicitly assumed.
- Budget: at most 128 bodies, 128 combined tendons/connections, 256 loads, 32 particles per mutual-gravity group. Larger or numerically extreme requests need an honest explanation, not a truncated scene.

JSON schema (defaults are declared representation conventions, not permission to ignore consequential missing information):
${JSON.stringify(z.toJSONSchema(DecisionSchema, { io: 'input' }))}`;
