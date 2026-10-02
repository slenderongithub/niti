# Launch the real compiled niti TUI in a pseudo-terminal and walk it like a user.
import os, pty, re, select, struct, fcntl, termios, time, subprocess, sys, tempfile, json, random
SP = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ["NITI_E2E_BIN"]  # holds the compiled niti + niti-core side by side (run.sh builds them)
llm = 49500 + random.randint(0, 300)
parent = os.path.realpath(tempfile.mkdtemp())
proj = os.path.join(parent, "redditreplica"); os.makedirs(os.path.join(proj, "src"))
open(os.path.join(proj, "src/a.ts"), "w").write("export const a = 1;\n")
os.makedirs(os.path.join(proj, ".niti"))
agents = "agents:\n" + "".join(
  f"  - id: {i}\n    provider: custom\n    model: fake\n    role: {i}\n    baseURL: http://127.0.0.1:{llm}/v1\n    systemPrompt: s\n" + ("    lead: true\n" if i == "backend" else "") + "    allowedTools: [read_file, write_file]\n"
  for i in ["backend", "frontend"]) + "verify: false\n"
open(os.path.join(proj, ".niti/agents.yaml"), "w").write(agents)
# a stray repo + .niti above the project, exactly the situation that used to capture it
os.makedirs(os.path.join(parent, ".git")); os.makedirs(os.path.join(parent, ".niti")); open(os.path.join(parent, "stray.txt"), "w").write("x")
state = tempfile.mkdtemp()
fake = subprocess.Popen(["bun", os.path.join(SP, "fakellm.ts"), str(llm), state], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.6)
env = dict(os.environ, TERM="xterm-256color", NITI_AUTH_FILE=os.path.join(state, "auth.json"), NITI_TRUST_FILE=os.path.join(state, "trust.json"), NITI_NO_MOUSE="1")
env.pop("NITI_TRUST", None)
pid, fd = pty.fork()
if pid == 0:
  os.chdir(proj); os.execve(os.path.join(BIN, "niti"), ["niti"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 140, 0, 0))
buf = ""
ansi = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]")
def read(t=0.3):
  global buf
  end = time.time() + t
  while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
      try: buf += os.read(fd, 65536).decode("utf8", "replace")
      except OSError: return
def screen(): return ansi.sub("", buf)
def wait(text, t=20):
  end = time.time() + t
  while time.time() < end:
    read(0.2)
    if text in screen(): return True
  return False
def send(s): os.write(fd, s.encode())
results = []
def check(name, ok): results.append((name, ok)); print(("PASS  " if ok else "FAIL  ") + name, flush=True)

check("trust prompt shown for a new folder", wait("Trust this folder?"))
read(1.0)
check("trust prompt names the launch folder, not the stray parent", "redditreplica" in screen())
send("1")
check("team picker shows the saved team", wait("backend", 25))
buf = ""; send("\r")
check("session opens", wait("Describe what to build", 30))
check("header shows the project folder", wait("redditreplica", 5))
check("Files panel shows src", "src" in screen())
check("Files panel does not show the stray parent's files", "stray.txt" not in screen())
buf = ""; send("hello\r")
check("chat reply appears", wait("Hello! What should we build?", 20))
buf = ""; send("/agents\r")
check("/agents opens", wait("frontend", 5))
send("\x1b"); read(0.5)
buf = ""; send("build a reddit replica page\r")
ok = False
end = time.time() + 40
while time.time() < end:
  read(0.3)
  s = screen()
  if "wants to run" in s or "[y]es" in s or "Allow once" in s: buf = ""; send("y")
  if os.path.exists(os.path.join(proj, "index.html")) and os.path.exists(os.path.join(proj, "style.css")): ok = True; break
check("approve with y in the real TUI writes the files", ok)
if not ok: os.kill(pid, 9); fake.kill(); sys.exit(1)
read(1.5)
# An approval that arrives as /quit is typed captures those keys (by design: nothing fires while a
# decision is pending). Answer whatever is pending, then quit; retry until the process is gone.
status = None
for _ in range(10):
  s = screen()
  if "wants to run" in s[-2000:]: send("n"); read(0.5)
  buf = ""; send("/quit\r")
  end = time.time() + 3
  while time.time() < end and status is None:
    read(0.2)
    p, st = os.waitpid(pid, os.WNOHANG)
    if p: status = st
  if status is not None: break
if status is None: os.kill(pid, 9); _, status = os.waitpid(pid, 0)
check("/quit exits cleanly", os.WEXITSTATUS(status) == 0)
check("no .niti written into the stray parent", sorted(os.listdir(os.path.join(parent, ".niti"))) == [])
check("core log written in the project", os.path.exists(os.path.join(proj, ".niti/core.log")))
time.sleep(0.5)
leftover = subprocess.run(["pgrep", "-f", "niti-core serve"], capture_output=True, text=True).stdout.strip()
check("no orphaned core after quit", leftover == "")
fake.kill()
print(f"\n{sum(1 for _, o in results if o)}/{len(results)} passed  (project {proj})")
sys.exit(0 if all(o for _, o in results) else 1)
