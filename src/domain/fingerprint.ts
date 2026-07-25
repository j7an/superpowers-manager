export function commitMatches(desired: string, observed: string): boolean {
  return (
    observed.length > 0 &&
    (observed === desired || observed === desired.slice(0, 7))
  );
}
