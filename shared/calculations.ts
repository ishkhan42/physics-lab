import { z } from 'zod';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const Operation = z.enum([
  'add', 'subtract', 'multiply', 'divide', 'sqrt', 'hypot', 'sin', 'cos', 'tan', 'atan2', 'pow', 'deg_to_rad', 'rad_to_deg',
]);
const Operand = z.union([
  z.number().finite(),
  z.strictObject({ ref: z.string().regex(ID) }),
  z.strictObject({ constant: z.literal('pi') }),
]);
const Request = z.strictObject({
  steps: z.array(z.strictObject({
    id: z.string().regex(ID),
    operation: Operation,
    args: z.array(Operand).max(8),
  })).min(1).max(32),
});

export type CalculationRequest = z.infer<typeof Request>;

function arity(operation: CalculationRequest['steps'][number]['operation'], count: number): boolean {
  switch (operation) {
    case 'add': case 'multiply': case 'subtract': case 'divide': case 'atan2': case 'pow': return count === 2;
    case 'hypot': return count >= 1 && count <= 8;
    case 'sqrt': case 'sin': case 'cos': case 'tan': case 'deg_to_rad': case 'rad_to_deg': return count === 1;
  }
}

function evaluate(operation: CalculationRequest['steps'][number]['operation'], args: number[]): number {
  switch (operation) {
    case 'add': return args[0]! + args[1]!;
    case 'subtract': return args[0]! - args[1]!;
    case 'multiply': return args[0]! * args[1]!;
    case 'divide':
      if (args[1] === 0) throw new Error('Division by zero is not defined.');
      return args[0]! / args[1]!;
    case 'sqrt': return Math.sqrt(args[0]!);
    case 'hypot': return Math.hypot(...args);
    case 'sin': return Math.sin(args[0]!);
    case 'cos': return Math.cos(args[0]!);
    case 'tan':
      if (Math.abs(Math.cos(args[0]!)) <= Number.EPSILON) throw new Error('Tangent is undefined at this angle.');
      return Math.tan(args[0]!);
    case 'atan2':
      if (args[0] === 0 && args[1] === 0) throw new Error('The angle of a zero vector is undefined.');
      return Math.atan2(args[0]!, args[1]!);
    case 'pow': return Math.pow(args[0]!, args[1]!);
    case 'deg_to_rad': return args[0]! * (Math.PI / 180);
    case 'rad_to_deg': return args[0]! * (180 / Math.PI);
  }
}

export function calculate(input: unknown): { results: Record<string, number> } {
  const parsed = Request.safeParse(input);
  if (!parsed.success) throw new Error('Invalid calculation request.');

  const values = new Map<string, number>();
  for (const step of parsed.data.steps) {
    if (values.has(step.id)) throw new Error('Calculation step IDs must be unique.');
    if (!arity(step.operation, step.args.length)) throw new Error('The operation received the wrong number of arguments.');
    const args: number[] = [];
    for (const arg of step.args) {
      if (typeof arg === 'number') args.push(arg);
      else if ('ref' in arg) {
        const value = values.get(arg.ref);
        if (value === undefined) throw new Error('References must name an earlier calculation step.');
        args.push(value);
      } else args.push(Math.PI);
    }
    const value = evaluate(step.operation, args);
    if (!Number.isFinite(value)) throw new Error('The calculation result must be finite.');
    values.set(step.id, value);
  }
  return { results: Object.fromEntries(values) };
}
