# Deliberate divergence: `int-5000-digits.json`

CPython's `int()` constructor refuses to convert a string of more than 4,300
digits (`sys.set_int_max_str_digits`, default limit). The withdrawn Python
overlay applier raised
`ValueError: Exceeds the limit (4300 digits) for integer string conversion`
during `json.load`, so the Python oracle **rejects** this file.

The TypeScript port never converts a JSON integer token to a numeric type —
`formatPythonNumber` in `src/python-json-format.ts` copies the source text of
an integer verbatim. Because the port never performs the conversion that
CPython's limit defends against (a denial-of-service on unbounded
int-to-string/string-to-int conversion), the port **accepts** this file and
reproduces its digits byte-for-byte.

This is an intentional widening of accepted input, not a parity gap, for the
reason stated above: the port's `formatPythonNumber` never performs the
integer conversion CPython's digit limit defends against, so the limit has
nothing to reject. The parity test in
`tests/baseline/manifest-overlay-parity.test.js` asserts only that the port
accepts this file — it does not compare the output against the oracle,
because the oracle never produces one.
