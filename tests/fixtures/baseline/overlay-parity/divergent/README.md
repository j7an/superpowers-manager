# Deliberate divergence: `int-5000-digits.json`

CPython's `int()` constructor refuses to convert a string of more than 4,300
digits (`sys.set_int_max_str_digits`, default limit). The withdrawn Python
overlay applier raised
`ValueError: Exceeds the limit (4300 digits) for integer string conversion`
during `json.load`, so the Python oracle **rejects** this file.

The TypeScript overlay preserves a validated JSON numeric token's raw source
text. Because it never performs the conversion that CPython's limit defends
against (a denial-of-service on unbounded int-to-string/string-to-int
conversion), the port **accepts** this file and reproduces its digits
byte-for-byte.

This is an intentional widening of accepted input, not a parity gap, for the
reason stated above: raw-token preservation never performs the integer
conversion CPython's digit limit defends against, so the limit has nothing to
reject. The baseline test in
`tests/baseline/harnesses/codex/manifest-overlay-parity.test.ts` asserts only that the port
accepts this file — it does not compare the output against the oracle,
because the oracle never produces one.
