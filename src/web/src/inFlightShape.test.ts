/**
 * **The shape that carries *not yet* is held on the source** (#778, ADR-0026).
 *
 * #775 closed its four occurrences and left two supports: a shape at the props
 * boundary — `readonly X[] | null`, `?? null` and never `?? []` — and the
 * route-driven net in `readsInFlight.test.tsx`. Three of the four occurrences
 * are held by the second. **The fourth is held by neither**, and the two
 * reasons compose:
 *
 *  1. **`tsc` does not close the shape.** `?? []` produces a `PerfPoint[]`,
 *     which satisfies `readonly PerfPoint[] | null`. That is ADR-0026's own
 *     arbitration — the front keeps one idiom instead of gaining a second —
 *     and it says in as many words that what closes the class is a test.
 *  2. **The net cannot see this one.** *In flight* (`points === null`) and
 *     *landed and empty* (`curve.length === 0`) are **identical on screen**:
 *     both render nothing, by ADR-0026 (*a block waiting on a needed read
 *     renders nothing at all*) crossed with *a block with nothing in it does
 *     not exist* (#724). No `data-empty` marker is emitted in either state, so
 *     no assertion about what a reader perceives can tell them apart.
 *
 * So the gate is neither the compiler nor the screen: it is **the source**, and
 * the two exits that were available are refused here rather than elsewhere.
 * *A visible marker on the landed-and-empty curve* separates the two states for
 * the net, but it is a rendering ADR-0026 and #724 both refuse, and reopening it
 * is an ADR amendment rather than a repair. *A type that closes at the compiler*
 * (`Read<T> = { landed: true; value: T } | { landed: false }`) puts two idioms
 * on one page for one rule, which is exactly what #775 refused. What is left is
 * the assertion on the source — which the Python half has a precedent for
 * (`test_positions.py` asserts on the source that one module is the only writer
 * of its two tables; #706 asserts that two callers hold the same function
 * object) and the front had none of.
 *
 * Three things about it are decisions:
 *
 *  - **It reads types, not text.** A regex over `?? []` would be blind to
 *    `?? EMPTY` and to a plain array handed over, and would fire on the five
 *    optional `?? []` that survive #775. The real program is built from
 *    `tsconfig.app.json` and the checker is asked what each slot was declared
 *    to hold — which is why the rule is about a **shape** and not a spelling.
 *  - **The family is `readonly X[] | null` and nothing else in the union.** A
 *    union carrying anything besides arrays and nothing-ness — `ClassValue`,
 *    say — is not a read that may be in flight, and judging it would make this
 *    gate a general-purpose nullability lint.
 *  - **Three doors, and no fourth.** A prop, and — *where the flattening happens
 *    upstream of the prop, the honesty goes upstream with it* — a declared local
 *    and an argument. Occurrence 2 has all three: the `?? null` the panel is
 *    handed, the annotated array the page builds it out of, and the call to
 *    `settledSeries`, which takes the N reads in the same shape and could
 *    therefore be flattened on the way **in** to the function that decides the
 *    state. A property assignment is deliberately **not** judged:
 *    `Filters.symbols` wears the same shape and its `null` means *no reduction*
 *    rather than *not read yet*, and a rule that cannot tell those apart would
 *    be asserting something it does not know.
 *
 * The five optional `?? []` of #718's distinction — the account name the
 * retired banner carried,
 * the shares page's failure counters, the installation badge, the orphan list,
 * the chart's marker rail — land in no such slot and are untouched, which is
 * the point of judging the slot rather than the operator.
 */
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')

// --------------------------------------------------------------------------- //
// The program
// --------------------------------------------------------------------------- //

/** The app's own program, off the very `tsconfig.app.json` `pnpm lint` reads. */
function appProgram(): ts.Program {
  const configPath = path.join(ROOT, 'tsconfig.app.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT)
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
}

// --------------------------------------------------------------------------- //
// The shape
// --------------------------------------------------------------------------- //

const NOTHING = ts.TypeFlags.Null | ts.TypeFlags.Undefined

function members(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type]
}

/** Can this value be absent at all — the whole of what the shape carries. */
function admitsNothing(type: ts.Type): boolean {
  return members(type).some((one) => (one.flags & NOTHING) !== 0)
}

describe('a read in flight is not an absence, held on the source', () => {
  const program = appProgram()
  const checker = program.getTypeChecker()

  const isArray = (one: ts.Type) => checker.isArrayType(one) || checker.isTupleType(one)
  const arrayPart = (type: ts.Type) => members(type).find(isArray)
  const elementOf = (type: ts.Type) => checker.getTypeArguments(type as ts.TypeReference)[0]

  /**
   * `readonly X[] | null`, and nothing else in the union: a slot whose whole
   * job is to tell *the read has not landed* from *the payload is empty*.
   */
  const family = (type: ts.Type): boolean => {
    const union = members(type)
    return (
      union.some(isArray) &&
      union.some((one) => (one.flags & ts.TypeFlags.Null) !== 0) &&
      union.every((one) => isArray(one) || (one.flags & NOTHING) !== 0)
    )
  }

  /** A slot that carries the distinction, at whatever depth it is declared. */
  const carries = (type: ts.Type): boolean => {
    if (family(type)) return true
    const outer = arrayPart(type)
    if (!outer || admitsNothing(type)) return false
    const element = elementOf(outer)
    return element !== undefined && carries(element)
  }

  /**
   * The defect: a slot declared to carry the distinction, handed a value that
   * cannot. Arrays are descended, because the page flattens a read per account
   * into one array and the annotation is where that honesty lives — so
   * `(readonly PerfPoint[] | null)[]` is the same rule one level down, and it is
   * the door the prop the ticket names sits behind.
   */
  const flattens = (declared: ts.Type, actual: ts.Type): boolean => {
    if (family(declared)) return !admitsNothing(actual)
    const outer = arrayPart(declared)
    const given = arrayPart(actual)
    if (outer && given && !admitsNothing(declared)) {
      const element = elementOf(outer)
      const handed = elementOf(given)
      if (element && handed) return flattens(element, handed)
    }
    return false
  }

  /** The three doors a value can reach a declared slot through. */
  type Door = 'prop' | 'local' | 'argument'

  /** Every slot carrying the distinction the walk met, by the door it came in. */
  const guarded: { door: Door; where: string }[] = []
  const offenders: string[] = []

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue
    const relative = path.relative(ROOT, file.fileName)
    if (!relative.startsWith('src' + path.sep)) continue
    // **The suite is not judged.** A test mounting a block on `[]` is
    // constructing *landed and empty* on purpose — that state is a payload and
    // exercising it is what a test is for. The rule is about what the app
    // composes, and a gate that forbade the fixture would forbid the very
    // assertion the two states exist to be told apart by.
    const inSuite =
      /\.test\.tsx?$/.test(relative) || relative.startsWith('src' + path.sep + 'test' + path.sep)
    if (inSuite) continue

    const at = (node: ts.Node) =>
      `${relative}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`

    const judge = (node: ts.Expression, declared: ts.Type, name: string, door: Door) => {
      const actual = checker.getTypeAtLocation(node)
      if (carries(declared)) {
        guarded.push({ door, where: `${at(node)} ${name}: ${checker.typeToString(declared)}` })
      }
      if (flattens(declared, actual)) {
        offenders.push(
          `${at(node)} — ${name} is declared ${checker.typeToString(declared)} and is ` +
            `handed ${checker.typeToString(actual)}, which cannot be null: ` +
            `a read in flight crosses it as an empty payload`,
        )
      }
    }

    const visit = (node: ts.Node): void => {
      // A prop: the boundary ADR-0026 states the shape at.
      if (ts.isJsxExpression(node) && node.expression && ts.isJsxAttribute(node.parent)) {
        const declared = checker.getContextualType(node.expression)
        if (declared) judge(node.expression, declared, node.parent.name.getText(), 'prop')
      }
      // A declared local: where the flattening is upstream, so is the honesty.
      if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
        judge(node.initializer, checker.getTypeFromTypeNode(node.type), node.name.getText(), 'local')
      }
      // An argument, for the same reason one level along: `settledSeries` takes
      // the N reads as `readonly (readonly PerfPoint[] | null)[]`, so the page
      // can flatten on the way *in* to the function that decides the state —
      // one call before the prop the ticket names.
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node)
        for (const [index, argument] of (node.arguments ?? []).entries()) {
          const declared = checker.getContextualType(argument)
          if (!declared) continue
          const parameter = signature?.getParameters()[index]
          judge(argument, declared, parameter?.getName() ?? `argument ${index + 1}`, 'argument')
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(file)
  }

  it('hands no slot of the family a value that cannot be null', () => {
    expect(offenders).toEqual([])
  })

  it('sees the family at every door it judges', () => {
    // The coverage half, and it is not decoration. With a `tsconfig` this file
    // failed to read, or `@/` unresolved, every declared type comes back `any`
    // and the assertion above passes on a front that has lost the shape
    // entirely — `readsInFlight.test.tsx` owes the same half to the same
    // argument, a net nobody swims into catching nothing. **Per door** rather
    // than in total, because the doors are three and a total hides two of them:
    // the prop door alone holds four slots, so a `ts.isVariableDeclaration`
    // branch that stopped matching — a TS AST change, a `satisfies` refactor —
    // would kill the upstream door in silence while both assertions stayed
    // green. That is the very failure this half exists against.
    const doors = [...new Set(guarded.map((one) => one.door))].sort()
    expect(doors, `the walk read nothing at some door: ${JSON.stringify(guarded, null, 2)}`).toEqual(
      ['argument', 'local', 'prop'],
    )
  })
})
