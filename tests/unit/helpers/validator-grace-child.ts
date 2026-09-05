process.on("SIGTERM", () => {
  process.stdout.write("during-grace\n");
});
process.stdout.write("ready\n");

// A pending Promise does not keep Node alive. This referenced handle keeps the
// direct process-group leader alive until runValidator's normal SIGKILL.
setInterval(() => {}, 2 ** 31 - 1);
