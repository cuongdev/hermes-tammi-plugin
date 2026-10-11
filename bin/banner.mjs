export function banner() {
  const tty = process.stdout.isTTY;
  const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = (s) => c("38;5;160", s);
  const pink = (s) => c("38;5;205", s);
  const dim = (s) => c("2", s);
  console.log(
    "\n" +
    red("  ╦ ╦┌─┐┬─┐┌┬┐┌─┐┌─┐  ") + pink("╔╦╗┌─┐┌┬┐┌┬┐┬") + "\n" +
    red("  ╠═╣├┤ ├┬┘│││├┤ └─┐  ") + pink(" ║ ├─┤│││││││") + "\n" +
    red("  ╩ ╩└─┘┴└─┴ ┴└─┘└─┘  ") + pink(" ╩ ┴ ┴┴ ┴┴ ┴┴") + "\n" +
    dim("  Hermes × Tammi plugin") + "\n" +
    dim("  chat with your Hermes agent from Tammi (Viettel)") + "\n",
  );
}
