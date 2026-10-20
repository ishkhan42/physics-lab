import type { Body, Quat, Scene, Vec3 } from '../../shared/scene.ts';
import { physicalScene } from '../../shared/scene.ts';
import { FIXED_TIMESTEP } from './clock.ts';
import { CONTACT_IMPEDANCE, CONTACT_STIFFNESS, FRICTION_REFERENCE, contactDamping, contactSubsteps, materialPairs, staticFriction } from './materials.ts';

export const JOINT_NAME_PREFIX = '_joint_';
export const GEOM_NAME_PREFIX = '_geom_';
export const PARTICLE_JOINT_SUFFIXES = ['_x', '_y', '_z'] as const;
export const FIXED_TENDON_NAME_PREFIX = '_fixed_tendon_';

const SOLREF = '0.005 1';

export function jointName(bodyId: string): string {
  return `${JOINT_NAME_PREFIX}${bodyId}`;
}

export function geomName(bodyId: string): string {
  return `${GEOM_NAME_PREFIX}${bodyId}`;
}

export function heldWeldName(bodyId: string): string {
  return `_held_${bodyId}`;
}

export function fixedTendonEqualityName(tendonId: string): string {
  return `${FIXED_TENDON_NAME_PREFIX}${tendonId}`;
}

function number(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function vector(values: readonly number[]): string {
  return values.map(number).join(' ');
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

function multiplyQuat(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

function inverseQuat(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + y * tz - z * ty,
    vy + w * ty + z * tx - x * tz,
    vz + w * tz + x * ty - y * tx,
  ];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function bodyLocalPoint(body: Body, worldPoint: Vec3): Vec3 {
  return rotate(inverseQuat(body.orientation), subtract(worldPoint, body.position));
}

function bodyLocalVector(body: Body, worldVector: Vec3): Vec3 {
  return rotate(inverseQuat(body.orientation), worldVector);
}

function relativePose(body: Body, parent: Body | undefined): { position: Vec3; orientation: Quat } {
  if (!parent) return { position: body.position, orientation: body.orientation };
  const parentInverse = inverseQuat(parent.orientation);
  return {
    position: rotate(parentInverse, subtract(body.position, parent.position)),
    orientation: multiplyQuat(parentInverse, body.orientation),
  };
}

function rgba(color: string): string {
  return `${number(parseInt(color.slice(1, 3), 16) / 255)} ${number(parseInt(color.slice(3, 5), 16) / 255)} ${number(parseInt(color.slice(5, 7), 16) / 255)} 1`;
}

function shapeGeom(body: Body, damping: number): string {
  const shape = body.shape;
  if (shape.kind === 'point') {
    return body.motion.kind === 'fixed'
      ? `<geom name="${geomName(body.id)}" type="sphere" size="0.025" mass="0" contype="0" conaffinity="0" rgba="${rgba(body.color)}"/>`
      : '';
  }

  let type: string;
  let size: number[];
  switch (shape.kind) {
    case 'sphere': type = 'sphere'; size = [shape.radius]; break;
    case 'box': type = 'box'; size = shape.size.map(value => value / 2); break;
    case 'cylinder': type = 'cylinder'; size = [shape.radius, shape.length / 2]; break;
    case 'capsule': type = 'capsule'; size = [shape.radius, shape.length / 2]; break;
    case 'ellipsoid': type = 'ellipsoid'; size = shape.radii; break;
    case 'plane': type = 'plane'; size = [shape.size[0], shape.size[1], 0.01]; break;
  }

  const moving = body.motion.kind !== 'fixed';
  const sliding = staticFriction(body);
  const condim = body.friction.rolling > 0 ? 6 : body.friction.torsional > 0 ? 4 : sliding > 0 ? 3 : 1;
  const mass = moving ? body.mass! : 0;
  const collision = body.heldBy == null ? '' : ' contype="0" conaffinity="0"';
  return `<geom name="${geomName(body.id)}" type="${type}" size="${vector(size)}" rgba="${rgba(body.color)}" friction="${vector([sliding, body.friction.torsional, body.friction.rolling])}" condim="${condim}" solref="${vector([-CONTACT_STIFFNESS, -damping])}" solimp="${CONTACT_IMPEDANCE}" mass="${number(mass)}"${collision}/>`;
}

function jointXml(body: Body): string {
  const motion = body.motion;
  if (motion.kind === 'fixed' || motion.kind === 'free') return '';
  if (motion.kind === 'particle') {
    const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    return axes.map((axis, index) => `<joint name="${jointName(body.id)}${PARTICLE_JOINT_SUFFIXES[index]}" type="slide" axis="${vector(bodyLocalVector(body, axis))}"/>`).join('');
  }
  if (motion.kind === 'ball') {
    return `<joint name="${jointName(body.id)}" type="ball" pos="0 0 0" damping="${number(motion.damping)}"/>`;
  }

  const anchor = bodyLocalPoint(body, motion.anchor);
  const axis = bodyLocalVector(body, motion.axis);
  const limits = motion.limits
    ? ` limited="true" range="${vector(motion.limits)}" solreflimit="${SOLREF}"`
    : ' limited="false"';
  return `<joint name="${jointName(body.id)}" type="${motion.kind}" pos="${vector(anchor)}" axis="${vector(axis)}" stiffness="${number(motion.stiffness)}" damping="${number(motion.damping)}" springref="${number(motion.springReference)}"${limits}/>`;
}

function bodyXml(body: Body, parent: Body | undefined, children: Map<string, Body[]>, sitesByBody: Map<string, Scene['sites']>, damping: Map<number, number>): string {
  const pose = relativePose(body, parent);
  const inner: string[] = [];
  if (body.motion.kind === 'free') inner.push(`<freejoint name="${jointName(body.id)}"/>`);
  if (body.motion.kind === 'particle') {
    // MuJoCo requires positive inertia even though this body's only DOFs are translation.
    inner.push(`<inertial pos="0 0 0" mass="${number(body.mass!)}" diaginertia="1e-12 1e-12 1e-12"/>`);
  }
  inner.push(jointXml(body));
  inner.push(shapeGeom(body, damping.get(body.restitution)!));
  for (const site of sitesByBody.get(body.id) ?? []) {
    inner.push(`<site name="${site.id}" pos="${vector(site.position)}" size="0.008"/>`);
  }
  for (const child of children.get(body.id) ?? []) inner.push(bodyXml(child, body, children, sitesByBody, damping));
  return `<body name="${body.id}" pos="${vector(pose.position)}" quat="${vector(pose.orientation)}">${inner.join('')}</body>`;
}

function connectionXml(scene: Scene): string[] {
  const bodies = new Map(scene.bodies.map(body => [body.id, body]));
  const xml: string[] = [];
  for (const connection of scene.connections) {
    if (connection.kind === 'connect') {
      const bodyA = bodies.get(connection.bodyA)!;
      const anchor = bodyLocalPoint(bodyA, connection.anchor);
      const bodyB = connection.bodyB ? ` body2="${connection.bodyB}"` : '';
      xml.push(`<connect name="${connection.id}" body1="${connection.bodyA}"${bodyB} anchor="${vector(anchor)}" solref="${SOLREF}"/>`);
    } else if (connection.kind === 'weld') {
      const bodyB = connection.bodyB ? ` body2="${connection.bodyB}"` : '';
      xml.push(`<weld name="${connection.id}" body1="${connection.bodyA}"${bodyB} solref="${SOLREF}"/>`);
    } else {
      xml.push(`<joint name="${connection.id}" joint1="${jointName(connection.bodyB)}" joint2="${jointName(connection.bodyA)}" polycoef="${vector([connection.offset, connection.ratio, 0, 0, 0])}" solref="${SOLREF}"/>`);
    }
  }
  return xml;
}

function tendonXml(scene: Scene): { tendons: string[]; equalities: string[] } {
  const tendons: string[] = [];
  const equalities: string[] = [];
  for (const tendon of scene.tendons) {
    const spring = tendon.mode === 'spring';
    const limit = tendon.mode === 'rope'
      ? ` limited="true" range="0 ${number(tendon.length)}" solreflimit="${SOLREF}"`
      : ' limited="false"';
    const springAttrs = spring
      ? ` stiffness="${number(tendon.stiffness)}" damping="${number(tendon.damping)}" springlength="${number(tendon.length)}"`
      : '';
    const path = tendon.path.map(part => {
      if (part.kind === 'site') return `<site site="${part.siteId}"/>`;
      if (part.kind === 'wrap') {
        const side = part.sideSiteId ? ` sidesite="${part.sideSiteId}"` : '';
        return `<geom geom="${geomName(part.bodyId)}"${side}/>`;
      }
      return `<pulley divisor="${number(part.divisor)}"/>`;
    }).join('');
    tendons.push(`<spatial name="${tendon.id}" width="0.005" rgba="${rgba(tendon.color)}"${limit}${springAttrs}>${path}</spatial>`);
    if (tendon.mode === 'fixed') {
      equalities.push(`<tendon name="${fixedTendonEqualityName(tendon.id)}" tendon1="${tendon.id}" polycoef="0 0 0 0 0" solref="${SOLREF}"/>`);
    }
  }
  return { tendons, equalities };
}

export function compileMjcf(input: Scene): string {
  const scene = physicalScene(input);
  const damping = new Map<number, number>();
  for (const body of scene.bodies) if (!damping.has(body.restitution)) damping.set(body.restitution, contactDamping(body.restitution));
  const children = new Map<string, Body[]>();
  const roots: Body[] = [];
  for (const body of scene.bodies) {
    if (body.parentId === null) roots.push(body);
    else {
      const siblings = children.get(body.parentId) ?? [];
      siblings.push(body);
      children.set(body.parentId, siblings);
    }
  }
  const sitesByBody = new Map<string, Scene['sites']>();
  for (const site of scene.sites) {
    if (site.bodyId === null) continue;
    const attached = sitesByBody.get(site.bodyId) ?? [];
    attached.push(site);
    sitesByBody.set(site.bodyId, attached);
  }
  const worldSites = scene.sites
    .filter(site => site.bodyId === null)
    .map(site => `<site name="${site.id}" pos="${vector(site.position)}" size="0.008"/>`);
  const tendon = tendonXml(scene);
  const bodyXmlLines = roots.map(body => bodyXml(body, undefined, children, sitesByBody, damping));
  const heldEqualities = scene.bodies.filter(body => body.heldBy != null)
    .map(body => `<weld name="${heldWeldName(body.id)}" body1="${body.heldBy}" body2="${body.id}" solref="${SOLREF}" active="true"/>`);
  const equalities = connectionXml(scene).concat(heldEqualities, tendon.equalities);
  const bodyLabels = scene.bodies.map(body => `<text name="_label_${body.id}" data="${escapeXml(body.label)}"/>`);
  const siteLabels = scene.sites.map(site => `<text name="_label_${site.id}" data="${escapeXml(site.label)}"/>`);
  const tendonLabels = scene.tendons.map(item => `<text name="_label_${item.id}" data="${escapeXml(item.label)}"/>`);
  const connectionLabels = scene.connections.map(item => `<text name="_label_${item.id}" data="${escapeXml(item.label)}"/>`);
  const attachedLabels = bodyLabels.concat(siteLabels, tendonLabels, connectionLabels).join('');
  const contacts = materialPairs(scene).map(pair => {
    const dimension = pair.rolling > 0 ? 6 : pair.torsional > 0 ? 4 : 3;
    return `<pair geom1="${geomName(pair.first.id)}" geom2="${geomName(pair.second.id)}" condim="${dimension}" friction="${vector([pair.static, pair.static, pair.torsional, pair.rolling, pair.rolling])}" solref="${vector([-CONTACT_STIFFNESS, -damping.get(pair.restitution)!])}" solreffriction="${FRICTION_REFERENCE}" solimp="${CONTACT_IMPEDANCE}"/>`;
  });

  return `<mujoco model="${escapeXml(scene.title)}">
<compiler angle="radian" autolimits="false"/>
<option timestep="${number(FIXED_TIMESTEP / contactSubsteps(scene))}" gravity="${vector(scene.gravity)}" integrator="implicitfast" cone="elliptic" solver="Newton" iterations="100"/>
<worldbody>${worldSites.join('')}${bodyXmlLines.join('')}</worldbody>
${contacts.length ? `<contact>${contacts.join('')}</contact>` : ''}
${tendon.tendons.length ? `<tendon>${tendon.tendons.join('')}</tendon>` : ''}
${equalities.length ? `<equality>${equalities.join('')}</equality>` : ''}
<custom>${attachedLabels}</custom>
</mujoco>`;
}
