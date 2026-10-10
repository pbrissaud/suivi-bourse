// `ui/` is not exempt from the overline: the table header lived here.
export function TableHead() {
  return <th className="h-10 uppercase" /> // expect: no-overline
}
