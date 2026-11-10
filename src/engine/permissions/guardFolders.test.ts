// The guard follows the shell's folder and reads variables. Every case is made up: nothing here touches the real
// file system, because `exists` is replaced where it matters.
import { describe, expect, test } from 'vitest'
import { type GuardContext, guardReason, isCdInside } from './guard'

const W = String.raw`C:\h\work\ws\14-x`
const S = String.raw`C:\h\scratch\ws\14-x`
const ctx: GuardContext = { worktree: W, additionalDirectories: [S], scratch: S, ownBranch: 'mainbus/14-x' }
const deep = `${W}\\src\\engine\\proposals`

const reason = (tool: string, command: string, c: Partial<GuardContext> = {}) =>
  guardReason(tool, { command }, { ...ctx, ...c })
const bash = (command: string, c: Partial<GuardContext> = {}) => reason('Bash', command, c)
const pwsh = (command: string, c: Partial<GuardContext> = {}) => reason('PowerShell', command, c)

describe('the shell folder', () => {
  test('cd back to the root from a subfolder is inside; from the root it leaves', () => {
    expect(bash('cd ../../..', { cwd: deep })).toBeNull()
    expect(bash('cd ../../.. && git status', { cwd: deep })).toBeNull()
    expect(bash('cd ../../..')).toMatchObject({ kind: 'hard_stop', message: expect.stringMatching(/^Leaves the ticket's folder: C:\\h$/) })
    expect(bash('cd ../../../..', { cwd: deep })).toMatchObject({ kind: 'hard_stop' })
  })

  test('Set-Location and cd in PowerShell follow the folder too', () => {
    expect(pwsh('Set-Location ..\\..\\..', { cwd: deep })).toBeNull()
    expect(pwsh('cd ..\\..\\..', { cwd: deep })).toBeNull()
    expect(pwsh('Set-Location ..\\..\\..')).toMatchObject({ kind: 'hard_stop' })
    expect(pwsh('Set-Location -Path ..\\..\\..', { cwd: deep })).toBeNull()
    expect(pwsh('sl ..; sl ..; Remove-Item x', { cwd: deep, exists: () => true })).toBeNull()
  })

  test('relative paths start from the folder', () => {
    expect(bash('rm ../../x.txt', { cwd: deep })).toBeNull()
    expect(bash('rm ../../../../x.txt', { cwd: deep })).toMatchObject({ kind: 'hard_stop' })
    expect(bash('rm ../x.txt')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('echo hi > ../out.txt', { cwd: `${W}\\src` })).toBeNull()
  })

  test('a folder outside the ticket makes relative writes outside', () => {
    expect(bash('rm x.txt', { cwd: 'C:\\other' })).toMatchObject({ kind: 'hard_stop', message: expect.stringContaining('C:\\other\\x.txt') })
  })

  test('a relative or missing folder is the worktree', () => {
    expect(bash('rm x.txt', { cwd: 'src' })).toBeNull()
    expect(bash('cd ../..', { cwd: '' })).toMatchObject({ kind: 'hard_stop' })
  })

  test('cd then cd back inside one command', () => {
    expect(bash('cd src/engine && cd ../.. && rm x')).toBeNull()
    expect(bash('cd src/engine && cd ../../.. && rm x')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('cd src/engine && rm ../../x')).toBeNull()
    expect(bash('cd src/engine && rm ../../../x')).toMatchObject({ kind: 'hard_stop' })
  })

  test('after ; or a new line the cd is taken to have worked only if the folder exists', () => {
    const command = 'cd src/engine; cd ../..; rm x'
    expect(bash(command, { exists: () => true })).toBeNull()
    expect(bash(command, { exists: () => false })).toMatchObject({ kind: 'hard_stop' })
    expect(bash('cd src/engine\ncd ../..\nrm x', { exists: () => true })).toBeNull()
    expect(bash('cd src/engine\nrm ../../../x', { exists: () => true })).toMatchObject({ kind: 'hard_stop' })
  })

  test('after || the cd may not have happened', () => {
    expect(bash('cd src || cd ../..', { exists: () => true })).toMatchObject({ kind: 'hard_stop' })
    // cd x || exit 1: what follows runs where the cd went.
    expect(bash('cd src/engine || exit 1\ncd ../..\nrm x', { exists: () => true })).toBeNull()
    expect(bash('cd src/engine || exit 1\nrm ../../../x', { exists: () => true })).toMatchObject({ kind: 'hard_stop' })
  })

  test('the folder is unknown after popd, a cd to a variable, a cd in a pipe or in an if', () => {
    const c = { cwd: `${W}\\src` }
    expect(bash('popd; rm ../x', c)).toMatchObject({ kind: 'hard_stop' })
    expect(bash('cd $X; rm ../x', c)).toMatchObject({ kind: 'hard_stop' })
    expect(bash('cd .. | cat; rm ../x', c)).toMatchObject({ kind: 'hard_stop' })
    expect(bash('if true; then cd ..; fi; rm ../x', c)).toMatchObject({ kind: 'hard_stop' })
    // Known again from the start of the next tool call: this is the same command's own view.
    expect(bash('rm ../x', c)).toBeNull()
  })

  test('cd - goes back to the previous folder inside one command', () => {
    expect(bash('cd src && cd - && rm x')).toBeNull()
    expect(bash('cd src/engine && cd .. && cd - && rm ../../x', { exists: () => true })).toBeNull()
    expect(bash('cd -')).toBeNull()
  })

  test('a cd that climbs inside a loop can walk out', () => {
    expect(bash('while true; do cd ..; done', { cwd: `${W}\\src` })).toMatchObject({ kind: 'hard_stop' })
    expect(bash('while true; do cd -; done')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('while true; do cd src; done')).toBeNull()
    // Over literal words the rounds are plain statements one after the other.
    expect(bash('for d in a b; do cd $d && ls && cd ..; done')).toBeNull()
    expect(bash('for d in a b; do cd $d; cd ..; cd ..; done')).toMatchObject({ kind: 'hard_stop' })
  })

  test('a bare cd goes home in Bash and stays in PowerShell', () => {
    expect(bash('cd && rm -rf x')).toMatchObject({ kind: 'hard_stop', message: "Leaves the ticket's folder: ~" })
    expect(bash('cd ~/src')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('cd ~root')).toMatchObject({ kind: 'hard_stop' })
    expect(pwsh('cd; Remove-Item x')).toBeNull()
    expect(pwsh('Set-Location')).toBeNull()
  })

  test('the settings checks use the folder', () => {
    expect(bash('echo x > settings.json', { cwd: `${W}\\.claude` })).toMatchObject({ message: expect.stringContaining('Changes agent or git settings') })
    expect(bash('cd .claude && echo x > settings.json')).toMatchObject({ message: expect.stringContaining('Changes agent or git settings') })
  })

  test('isCdInside starts from the folder', () => {
    const folders = { worktree: W, additionalDirectories: [] as string[], cwd: deep }
    expect(isCdInside(['cd', '../../..'], folders)).toBe(true)
    expect(isCdInside(['cd', '../../..'], { ...folders, cwd: undefined })).toBe(false)
    expect(isCdInside(['cd', '-'], folders)).toBe(false)
    expect(isCdInside(['cd'], folders)).toBe(false)
    expect(isCdInside(['cd', '~/x'], folders)).toBe(false)
  })
})

describe('variables', () => {
  test('$TEMP in quotes, after export and in redirects', () => {
    expect(bash('export MAINBUS_HOME="$TEMP/mbhome"; pnpm exec vitest run > "$TEMP/unit.log"')).toBeNull()
    expect(bash('export MAINBUS_HOME="$TEMP/mbhome" && pnpm exec vitest run > "$TEMP/unit.log" 2>&1')).toBeNull()
    expect(bash('X=1; echo hi > "$TEMP/a"')).toBeNull()
    expect(bash('export A=1 B=2; echo hi >> $TMP/a')).toBeNull()
    expect(bash('export TEMP=/x; echo hi > "$TEMP/a"')).toMatchObject({ kind: 'hard_stop' })
  })

  test('$env:TEMP and $PWD in PowerShell', () => {
    const junction =
      'New-Item -ItemType Junction -Path "$env:TEMP\\mainsrc\\node_modules" -Target "$PWD\\node_modules" | Out-Null'
    expect(pwsh(junction)).toBeNull()
    expect(pwsh(junction, { cwd: 'C:\\other' })).toMatchObject({ kind: 'hard_stop' })
    expect(pwsh('New-Item -Path "$env:TEMP\\a" -Target "$HOME\\b"')).toMatchObject({ kind: 'hard_stop' })
    expect(pwsh('Set-Content -Path "$PWD\\a.txt" hi')).toBeNull()
  })

  test('$PWD in Bash is the folder the command starts in', () => {
    expect(bash('cp a.txt $PWD/b.txt')).toBeNull()
    expect(bash('cp a.txt "$PWD/b.txt"', { cwd: deep })).toBeNull()
    expect(bash('cp a.txt $PWD/b.txt', { cwd: 'C:\\other' })).toMatchObject({ kind: 'hard_stop' })
    expect(bash('cd src && cp a.txt $PWD/b.txt')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('cd "$PWD"; git status')).toBeNull()
  })

  test('%TEMP% names the scratch folder only while the folder is plainly inside', () => {
    expect(bash('echo hi > %TEMP%\\a')).toBeNull()
    expect(pwsh('Set-Content %TMP%\\a hi')).toBeNull()
    expect(bash('echo hi > %TEMP%\\a', { cwd: 'C:\\other' })).toMatchObject({ kind: 'hard_stop' })
    expect(bash('echo hi > %TEMP%\\a', { cwd: `${W}\\.claude` })).toMatchObject({ kind: 'hard_stop' })
  })

  test('assignments earlier in the same command line', () => {
    expect(bash('R=/c/h/work/ws/14-x; mkdir -p $R/x')).toBeNull()
    expect(bash('R="/c/h/work/ws/14-x" && mkdir -p "$R/x" && rm -rf ${R}/y')).toBeNull()
    expect(bash('R=/c/Users/u; mkdir -p $R/x')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('D="$TEMP/dl"; cd "$D"')).toBeNull()
    expect(bash('D="$TEMP/dl"; cd "$D/../.."')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('D="$TEMP/dl"; mkdir -p "$D/x" && cd "$D/x" && ls ..', { exists: () => true })).toBeNull()
    // A prefix assignment belongs to its command alone.
    expect(bash('R=/c/h/work/ws/14-x mkdir $R/x')).toMatchObject({ kind: 'hard_stop' })
    // A value with a variable of its own is not known.
    expect(bash('R=$HOME/x; mkdir $R')).toMatchObject({ kind: 'hard_stop' })
    // Splitting and globbing: an unquoted read of such a value stays unknown.
    expect(bash('R="/c/h/work/ws/14-x/a b"; mkdir $R')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('R="/c/h/work/ws/14-x/a b"; mkdir "$R"')).toBeNull()
    expect(bash('R=/c/h/work/ws/14-x/*; rm $R')).toMatchObject({ kind: 'hard_stop' })
  })

  test('PowerShell assignments of a quoted string', () => {
    expect(pwsh("$R = 'C:\\h\\work\\ws\\14-x'; mkdir $R\\y")).toBeNull()
    expect(pwsh('$R = "$env:TEMP\\x"; mkdir "$R\\y"')).toBeNull()
    expect(pwsh("$R = 'C:\\Users\\u'; mkdir $R\\y")).toMatchObject({ kind: 'hard_stop' })
    expect(pwsh('$R = $env:USERPROFILE; mkdir $R\\y')).not.toBeNull()
    expect(pwsh("$R = 'C:\\h\\work\\ws\\14-x'; $R += 'x'; mkdir $R\\y")).not.toBeNull()
    expect(pwsh("$R = 'C:\\h\\work\\ws\\14-x'; Set-Variable R 'C:\\Users\\u'; mkdir $R\\y")).toMatchObject({ kind: 'hard_stop' })
  })

  test('commands that can change a variable clear what was known', () => {
    for (const c of [
      'read TEMP; echo hi > $TEMP/a',
      'unset TEMP; echo hi > $TEMP/a',
      'export TEMP; echo hi > $TEMP/a',
      'eval x; echo hi > $TEMP/a',
      'source x.sh; echo hi > $TEMP/a',
      'IFS=/; echo hi > $TEMP/a',
      'TEMP+=/x; echo hi > $TEMP/a',
      'declare -n TEMP=Y; echo hi > $TEMP/a',
      'R=/c/h/work/ws/14-x; read R; mkdir $R/x',
      'select TEMP in a; do echo hi > $TEMP/a; done',
    ]) {
      expect(bash(c), c).not.toBeNull()
    }
  })

  test('unknown variables still ask', () => {
    for (const c of ['rm $X', 'rm src/$X', 'echo hi > "$HOME/x"', 'echo hi > $TEMP/$f', 'cd "$X"']) {
      expect(bash(c), c).toMatchObject({ kind: 'hard_stop' })
    }
    // A variable in the middle of a path is a variable.
    expect(bash('rm -rf src/$X')).toMatchObject({ kind: 'hard_stop', message: expect.stringContaining('$X') })
    expect(bash('X=../../..; rm -rf src/$X')).toMatchObject({ kind: 'hard_stop' })
    expect(bash(`X=../../..; rm -rf ${W.replaceAll('\\', '/')}/$X`)).toMatchObject({ kind: 'hard_stop' })
    expect(bash('X=sub; rm -rf src/$X')).toBeNull()
  })

  test('single quotes keep a variable as text; an escaped one too', () => {
    expect(bash("echo hi > '$TEMP/a'")).toMatchObject({ kind: 'hard_stop' })
    expect(bash('echo hi > "\\$TEMP/a"')).toMatchObject({ kind: 'hard_stop' })
  })

  test('a variable in the place of the command stays opaque', () => {
    expect(bash('X=rm; $X -rf src')).toMatchObject({ kind: 'automatic' })
    expect(pwsh("$x = 'Remove-Item'; $x foo")).toMatchObject({ kind: 'automatic' })
  })
})

describe('loops', () => {
  test('a loop over literal words is judged once per word', () => {
    expect(bash('for f in a b; do git show main:$f > "$TEMP/rv/base/$f"; done')).toBeNull()
    expect(bash('for f in a b; do echo hi > "$TEMP/$f"; done; echo hi > $f')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for f in a "../../x"; do rm $f; done')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for f in a /c/Users/u/b; do rm $f; done')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for f in a b; do for g in c d; do echo hi > "$TEMP/$f/$g"; done; done')).toBeNull()
    expect(bash('for f in a b\ndo\n  rm -rf "$f"\ndone')).toBeNull()
  })

  test('a glob list: the folder part is checked and a quoted read is a file inside it', () => {
    expect(bash('for f in src/*.ts; do cp "$f" "$TEMP/rv/$f"; done')).toBeNull()
    expect(bash('for f in src/*.ts; do rm $f; done')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for f in *.ts; do rm "$f/../../x"; done')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for f in ../*.ts; do cp "$f" "$TEMP/x"; done; echo hi > "$f"')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for f in .*; do rm "$f"; done')).toMatchObject({ kind: 'hard_stop' })
  })

  test('a list that is not literal leaves the variable unknown', () => {
    expect(bash('for f in "$@"; do rm "$f"; done')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for f in $LIST; do rm "$f"; done')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for f; do rm "$f"; done')).toMatchObject({ kind: 'hard_stop' })
  })

  test('the loop variable is unknown after the loop, and a loop that changes what it read is opaque', () => {
    expect(bash('for f in a b; do :; done; rm $f')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for i in 1 2; do echo hi > $TEMP/a; TEMP=/x; done')).toMatchObject({ kind: 'automatic' })
    expect(bash('for i in 1 2; do TEMP=/x; echo hi > $TEMP/a; done')).toMatchObject({ kind: 'hard_stop' })
    expect(bash('for i in 1 2; do Y=$i; done; rm $Y')).not.toBeNull()
  })

  test('private-use characters in a command are opaque', () => {
    expect(bash('echo \uE000')).toMatchObject({ kind: 'automatic' })
  })
})

describe('reserved words no longer hide the command', () => {
  test.each([
    ['while true; do git push; done', 'Pushes commits to a remote'],
    ['until false; do git push -f; done', 'Force-pushes to a remote'],
    ['if true; then git push; fi', 'Pushes commits to a remote'],
    ['if true; then :; else git push; fi', 'Pushes commits to a remote'],
    ['if false; then :; elif git push; then :; fi', 'Pushes commits to a remote'],
    ['! git push', 'Pushes commits to a remote'],
    ['for x in 1; do git push; done', 'Pushes commits to a remote'],
    ['for x in 1; do rm -rf /c/Users/u/Documents; done', "Writes outside the ticket's folder: C:\\Users\\u\\Documents"],
    ['if true; then rm -rf /c/Users/u/Documents; fi', "Writes outside the ticket's folder: C:\\Users\\u\\Documents"],
    ['! rm -rf /c/Users/u/Documents', "Writes outside the ticket's folder: C:\\Users\\u\\Documents"],
    ['for x in 1; do cat .env; done', 'Reads a credentials file: .env'],
    ['for f in .env*; do echo $f; done', 'Reads a credentials file: .env*'],
    ['while read l; do cat .npmrc; done', 'Reads a credentials file: .npmrc'],
    ['for x in 1; do echo hi; done > C:/Users/u/out', "Writes outside the ticket's folder: C:\\Users\\u\\out"],
  ])('%s', (command, message) => {
    expect(bash(command)).toMatchObject({ kind: 'hard_stop', message })
  })

  test('harmless loops raise nothing', () => {
    expect(bash('for x in 1 2; do echo $x; done')).toBeNull()
    expect(bash('if test -f a; then cat a; fi')).toBeNull()
    expect(bash('while true; do git status; done')).toBeNull()
    expect(bash('for x in 1; do echo hi; done > out.txt')).toBeNull()
  })
})

describe('heredocs', () => {
  test('cat and tee are judged by where they write', () => {
    expect(bash("cat > src/x.ts <<'EOF'\nhello\nEOF")).toBeNull()
    expect(bash('cat > src/x.ts <<EOF\nhello\nEOF')).toBeNull()
    expect(bash("cat <<'EOF' > src/x.ts\nhello\nEOF")).toBeNull()
    expect(bash("cat >> $TEMP/x.txt <<'EOF'\nhello\nEOF")).toBeNull()
    expect(bash("cd src && cat > x.ts <<'EOF'\nhello\nEOF")).toBeNull()
    expect(bash("tee src/a.txt <<'EOF'\nhello\nEOF")).toBeNull()
    expect(bash("cat > x <<-'EOF'\n\thello\n\tEOF")).toBeNull()
    expect(bash("cat > a <<'ONE' && cat > b <<'TWO'\n1\nONE\n2\nTWO")).toBeNull()
    expect(bash('cat <<EOF\r\nhi\r\nEOF\r\n')).toBeNull()
  })

  test('a write outside the folders is still refused', () => {
    expect(bash("cat > /c/Users/u/x <<'EOF'\nhello\nEOF")).toMatchObject({
      kind: 'hard_stop',
      message: "Writes outside the ticket's folder: C:\\Users\\u\\x",
    })
    expect(bash("cat <<'EOF' > /tmp/x\nhello\nEOF")).toMatchObject({ kind: 'hard_stop' })
    expect(bash("tee /tmp/a <<'EOF'\nhello\nEOF")).toMatchObject({ kind: 'hard_stop' })
    expect(bash("cat > .claude/settings.json <<'EOF'\nx\nEOF")).toMatchObject({ kind: 'hard_stop' })
  })

  test('what follows the heredoc is still judged', () => {
    expect(bash("cat > a <<'EOF'\nx\nEOF\ngit push")).toMatchObject({ kind: 'hard_stop', message: 'Pushes commits to a remote' })
    expect(bash("cat > a <<'EOF' && git push\nx\nEOF")).toMatchObject({ kind: 'hard_stop', message: 'Pushes commits to a remote' })
  })

  test('the text of the heredoc is data, not commands', () => {
    expect(bash("cat > a <<'EOF'\ngit push\nrm -rf /\nEOF")).toBeNull()
  })

  test('interpreters fed by a heredoc still ask', () => {
    for (const c of [
      'python - <<EOF\nprint(1)\nEOF',
      "node - <<'EOF'\nconsole.log(1)\nEOF",
      "bash <<'EOF'\nrm -rf x\nEOF",
      "sh <<'EOF'\nls\nEOF",
      "psql <<'EOF'\nselect 1\nEOF",
      "cat <<'EOF' | bash\nls\nEOF",
      "cat <<'EOF' | python\nprint(1)\nEOF",
    ]) {
      expect(bash(c), c).toMatchObject({ kind: 'automatic' })
    }
  })

  test('an unquoted delimiter whose text would run commands, a here-string and an unfinished heredoc ask', () => {
    expect(bash('cat > a <<EOF\n$(rm -rf /)\nEOF')).toMatchObject({ kind: 'automatic' })
    expect(bash('cat > a <<EOF\n`ls`\nEOF')).toMatchObject({ kind: 'automatic' })
    expect(bash("cat > a <<'EOF'\n$(rm -rf /)\nEOF")).toBeNull()
    expect(bash('cat > a <<<hello')).toMatchObject({ kind: 'automatic' })
    expect(bash('cat > a <<EOF\nhello')).toMatchObject({ kind: 'automatic' })
    expect(bash('cat > a <<EOF')).toMatchObject({ kind: 'automatic' })
    expect(bash('cat > a << $X\nhello\n$X')).toMatchObject({ kind: 'automatic' })
  })
})

describe('credentials in the guard follow the files', () => {
  test('a heredoc to a credentials file is still a credentials card where the file is read', () => {
    expect(bash('cat .npmrc')).toMatchObject({ kind: 'hard_stop', message: expect.stringContaining('Reads a credentials file') })
  })
})
