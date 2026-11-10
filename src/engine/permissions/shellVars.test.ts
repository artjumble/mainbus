import { describe, expect, test } from 'vitest'
import { parseShell, parseShellDetailed, peelReserved, plainStages, type ShellVars } from './shell'

const bashVars = (known: Record<string, string> = {}): ShellVars => ({ dialect: 'bash', known: new Map(Object.entries(known)) })
const pwshVars = (known: Record<string, string> = {}): ShellVars => ({ dialect: 'powershell', known: new Map(Object.entries(known)) })

/** Each pipeline's words, or the reason it is opaque. */
function words(command: string, vars?: ShellVars): string[][][] | string {
  const p = parseShellDetailed(command, vars)
  return p.opaque ? `opaque: ${p.why}` : p.pipelines.map((pl) => pl.map((c) => c.argv))
}

/** The words of the last command, or the reason it is opaque. */
function last(command: string, vars?: ShellVars): string[] | string {
  const p = parseShellDetailed(command, vars)
  return p.opaque ? `opaque: ${p.why}` : (p.pipelines.at(-1)?.at(-1)?.argv ?? [])
}

function argvs(command: string): string[][][] {
  const p = parseShell(command)
  if (p.opaque) throw new Error(`opaque: ${p.why}`)
  return p.pipelines.map((pl) => pl.map((c) => c.argv))
}

describe('statement joins', () => {
  test('say how each statement follows the one before', () => {
    const p = parseShellDetailed('a && b || c; d\ne')
    expect(p.opaque).toBe(false)
    expect(!p.opaque && p.joins).toEqual([';', '&&', '||', ';', ';'])
  })

  test('a dropped statement makes the next join a ;', () => {
    const p = parseShellDetailed('a && && b', bashVars())
    expect(!p.opaque && p.joins).toEqual([';', ';'])
  })

  test('parseShell keeps its old shape', () => {
    expect(parseShell('a && b')).toEqual({
      opaque: false,
      pipelines: [[{ name: 'a', argv: ['a'], redirects: [] }], [{ name: 'b', argv: ['b'], redirects: [] }]],
    })
  })
})

describe('reading variables', () => {
  test('without variables the text stays as typed', () => {
    expect(words('rm $TEMP/x "$TEMP/y"')).toEqual([[['rm', '$TEMP/x', '$TEMP/y']]])
    expect(parseShell('echo $X').opaque).toBe(false)
  })

  test('known names are replaced in unquoted and double-quoted words and in redirects', () => {
    const v = bashVars({ TEMP: 'C:\\s', A: 'one' })
    expect(words('rm $TEMP/x "$TEMP/y z" ${TEMP}/w a$A.log', v)).toEqual([[['rm', 'C:\\s/x', 'C:\\s/y z', 'C:\\s/w', 'aone.log']]])
    const p = parseShellDetailed('echo hi > "$TEMP/o.log" 2>> $TEMP/e.log', v)
    expect(!p.opaque && p.pipelines[0][0].redirects).toEqual(['C:\\s/o.log', 'C:\\s/e.log'])
  })

  test('single quotes and escapes keep the text', () => {
    const v = bashVars({ TEMP: 'C:\\s' })
    expect(words("echo '$TEMP' \\$TEMP \"\\$TEMP\"", v)).toEqual([[['echo', '$TEMP', '\\$TEMP', '\\$TEMP']]])
  })

  test('unknown names, other cases and other braces stay as typed', () => {
    const v = bashVars({ TEMP: 'C:\\s' })
    expect(words('echo $temp $TEMPX $Y ${Y}', v)).toBe('opaque: braces')
    expect(words('echo $temp $TEMPX $Y', v)).toEqual([[['echo', '$temp', '$TEMPX', '$Y']]])
  })

  test('a word with an unknown read goes back to its text as typed', () => {
    const v = bashVars({ TEMP: 'C:\\s' })
    expect(words('rm $TEMP/$f', v)).toEqual([[['rm', '$TEMP/$f']]])
    expect(words('rm "$TEMP/$f/x"', v)).toEqual([[['rm', '$TEMP/$f/x']]])
  })

  test('an unquoted read of a value with spaces or wildcards is not expanded in Bash', () => {
    const v = bashVars({ A: 'a b', G: 'x*', E: '' })
    expect(words('rm $A "$A" $G "$G" $E', v)).toEqual([[['rm', '$A', 'a b', '$G', 'x*', '$E']]])
    expect(words('rm $A', pwshVars({ a: 'a b' }))).toEqual([[['rm', 'a b']]])
  })

  test('the name of the command is never expanded', () => {
    expect(words('$X -rf y', bashVars({ X: 'rm' }))).toBe('opaque: the command name comes from a variable')
    expect(words('X=rm; $X y', bashVars())).toBe('opaque: the command name comes from a variable')
  })

  test('PowerShell reads are case-insensitive; $TEMP is not env:TEMP', () => {
    const v = pwshVars({ 'env:temp': 'C:\\s', pwd: 'C:\\w' })
    expect(words('Set-Content $env:TEMP\\a "$ENV:Temp\\b" $PWD\\c "$pwd\\d"', v)).toEqual([
      [['Set-Content', 'C:\\s\\a', 'C:\\s\\b', 'C:\\w\\c', 'C:\\w\\d']],
    ])
    expect(words('Set-Content $TEMP\\a', v)).toEqual([[['Set-Content', '$TEMP\\a']]])
    // A drive or scope qualifier is not a variable.
    expect(words('Get-Content $x:foo', pwshVars({ x: 'y' }))).toEqual([[['Get-Content', '$x:foo']]])
  })

  test('%TEMP% names the value given, in any case', () => {
    const v = { ...bashVars(), percent: 'C:\\s' }
    expect(words('echo hi > %TEMP%\\a "%tmp%/b" %TEMPX%', v)).toEqual([[['echo', 'hi', '>', 'C:\\s\\a', 'C:\\s/b', '%TEMPX%']]].map(() => [['echo', 'hi', 'C:\\s/b', '%TEMPX%']]))
  })

  test('the variables given are not changed', () => {
    const v = bashVars({ A: '1' })
    parseShellDetailed('A=2; B=3; unset A', v)
    expect([...v.known]).toEqual([['A', '1']])
  })
})

describe('assignments in the same command', () => {
  test('a value set earlier is read later, also after export and builtin', () => {
    const v = bashVars()
    expect(last('A=/x; echo $A', v)).toEqual(['echo', '/x'])
    expect(last('export A=/x; export B="$A/y"; echo $A $B', v)).toEqual(['echo', '/x', '/x/y'])
    // Within one command the words are read before anything is set.
    expect(last('export A=/x B="$A/y"; echo $A $B', v)).toEqual(['echo', '/x', '$B'])
    expect(last('builtin export A=/x; echo $A', v)).toEqual(['echo', '/x'])
    expect(last('A=1 B=2; echo $A$B', v)).toEqual(['echo', '12'])
    expect(last('declare A=/x; local B=/y; readonly C=/z; echo $A$B$C', v)).toEqual(['echo', '/x/y/z'])
    expect(last('A=1 export B=2; echo $B', v)).toEqual(['echo', '2'])
    expect(last('if true; then A=/x; fi; echo $A', v)).toEqual(['echo', '/x'])
  })

  test('a prefix assignment is the command’s own', () => {
    expect(words('A=/x; A=/y echo $A; echo $A', bashVars())).toEqual([[['echo', '$A']], [['echo', '$A']]])
    const p = parseShellDetailed('A=/x echo hi > $A/o', bashVars({ A: '/w' }))
    expect(!p.opaque && p.pipelines[0][0].redirects).toEqual(['$A/o'])
  })

  test('a value with a variable that is not known makes the name unknown', () => {
    expect(words('A=/x; A=$Y/z; echo $A', bashVars())).toEqual([[['echo', '$A']]])
    expect(words('A=/x; A=; echo $A', bashVars())).toEqual([[['echo', '$A']]])
  })

  test('what can change variables by name clears what was known', () => {
    for (const c of [
      'read A', 'unset A', 'export A', 'export -n A=1', 'export "$n=1"', 'eval x', 'source x', '. x', 'printf -v A x', 'declare -n A=B',
      'let A=1', 'getopts a A', 'mapfile A', 'IFS=/', 'A+=x', 'A[0]=x', 'select A in a b', 'X=1 read A',
    ]) {
      expect(last(`${c}; echo $A`, bashVars({ A: '/x' })), c).toEqual(['echo', '$A'])
    }
  })

  test('assignments in a pipe do not count', () => {
    expect(last('A=/y | cat; echo $A', bashVars({ A: '/x' }))).toEqual(['echo', '$A'])
  })

  test('cd makes PWD unknown', () => {
    expect(words('cd src; echo $PWD', bashVars({ PWD: '/w' }))).toEqual([[['cd', 'src']], [['echo', '$PWD']]])
    expect(words('echo $PWD; cd src', bashVars({ PWD: '/w' }))).toEqual([[['echo', '/w']], [['cd', 'src']]])
  })

  test('PowerShell assignments of one quoted string are variables, and are not commands', () => {
    const v = pwshVars()
    expect(words("$R = 'C:\\x'; mkdir $R\\y", v)).toEqual([[['mkdir', 'C:\\x\\y']]])
    expect(words('$R = "C:\\x"; mkdir "$R\\y"', v)).toEqual([[['mkdir', 'C:\\x\\y']]])
    expect(words('$r = "$env:TEMP\\x"; mkdir $R', pwshVars({ 'env:temp': 'C:\\s' }))).toEqual([[['mkdir', 'C:\\s\\x']]])
    // Anything else starting with $ is still not a command Mainbus can read.
    expect(words('$R = Get-Date; mkdir $R', v)).toBe('opaque: the command name comes from a variable')
    expect(words("$R = 'a' + 'b'; mkdir $R", v)).toBe('opaque: the command name comes from a variable')
    expect(words("$R = 'a'; $R += 'b'; mkdir $R", v)).toBe('opaque: the command name comes from a variable')
  })

  test('PowerShell commands that change variables clear what was known', () => {
    for (const c of ["Set-Variable R 'x'", "sv R 'x'", 'Remove-Variable R', 'Set-Item env:R x', '. .\\x.ps1', '.\\x.ps1', 'set R=x']) {
      expect(last(`${c}; mkdir $R`, pwshVars({ r: 'C:\\x' })), c).toEqual(['mkdir', '$R'])
    }
    expect(last('iex $s; mkdir $R', pwshVars({ r: 'C:\\x' }))).toMatch(/^opaque/)
  })
})

describe('reserved words', () => {
  test('are peeled off the command', () => {
    expect(peelReserved(['do', 'git', 'push'])).toEqual(['git', 'push'])
    expect(peelReserved(['!', 'if', 'x'])).toEqual(['x'])
    expect(peelReserved(['done'])).toEqual([])
    expect(peelReserved(['echo', 'do'])).toEqual(['echo', 'do'])
  })

  test('the command after them is parsed', () => {
    expect(argvs('while true; do git push; done')).toEqual([[['true']], [['git', 'push']]])
    expect(argvs('if a; then b; elif c; then d; else e; fi')).toEqual([[['a']], [['b']], [['c']], [['d']], [['e']]])
    expect(argvs('! rm x')).toEqual([[['rm', 'x']]])
  })

  test('done keeps its redirects', () => {
    const p = parseShell('for x in 1; do echo hi; done > out.txt')
    expect(!p.opaque && p.pipelines.at(-1)?.[0]).toMatchObject({ name: '', redirects: ['out.txt'] })
  })

  test('plainStages is unchanged: the words as typed', () => {
    expect(plainStages('while true; do git push; done')).toEqual([['while', 'true'], ['do', 'git', 'push'], ['done']])
  })
})

describe('for loops', () => {
  const v = (): ShellVars => bashVars({ TEMP: 'C:\\s' })

  test('over literal words, the body is repeated once per word', () => {
    expect(words('for f in a b; do echo $f; done', v())).toEqual([[['for', 'f', 'in', 'a', 'b']], [['echo', 'a']], [['echo', 'b']]])
    expect(words('for f in a b; do echo "$TEMP/$f"; done', v())).toEqual([
      [['for', 'f', 'in', 'a', 'b']],
      [['echo', 'C:\\s/a']],
      [['echo', 'C:\\s/b']],
    ])
  })

  test('nested loops multiply', () => {
    expect(words('for f in a b; do for g in c d; do echo $f$g; done; done', v()).length).toBe(1 + 2 + 4)
  })

  test('how many statements follow from a loop is limited', () => {
    const many = Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ')
    expect(words(`for a in ${many}; do for b in ${many}; do for c in ${many}; do echo; done; done; done`, v())).toBe('opaque: a loop with too many commands')
  })

  test('a glob list gives a quoted read the name; unquoted reads stay', () => {
    expect(words('for f in src/*.ts; do echo "$f" $f; done', v())).toEqual([[['for', 'f', 'in', 'src/*.ts']], [['echo', 'f', '$f']]])
  })

  test('lists that are not literal leave the variable unknown', () => {
    for (const list of ['"$@"', '$X', '../a', '/etc/*', '~/x', '.*', 'a b $Y', '"a b"']) {
      expect(words(`for f in ${list}; do echo "$f"; done`, v()), list).toContainEqual([['echo', '$f']])
    }
  })

  test('the variable is unknown after the loop, and the placeholder never leaks', () => {
    expect(words('for f in a; do :; done; echo $f', v())).toContainEqual([['echo', '$f']])
    expect(words('for f in a b; do Y=$f; done; echo $Y', v())).toBe('opaque: a loop variable used outside its loop')
  })

  test('a loop that changes what it reads is opaque', () => {
    expect(words('for i in 1 2; do echo $TEMP; TEMP=x; done', v())).toBe('opaque: a loop that changes a variable it reads')
    expect(words('for i in 1 2; do TEMP=x; echo $TEMP; done', v())).not.toBe('opaque: a loop that changes a variable it reads')
    expect(words('while true; do echo $TEMP; cd src; echo $TEMP; done', v())).not.toContain('opaque')
    expect(words('while true; do echo $PWD; cd src; done', bashVars({ PWD: '/w' }))).toBe('opaque: a loop that changes a variable it reads')
  })

  test('statements know how deeply they are nested', () => {
    const p = parseShellDetailed('echo a; while true; do cd ..; done; if x; then cd y; fi; for d in p q; do cd $d; done', v())
    expect(p.opaque).toBe(false)
    if (p.opaque) return
    const names = p.pipelines.map((pl) => pl.map((c) => c.argv.join(' ')).join('|'))
    expect(names).toEqual(['echo a', 'true', 'cd ..', 'x', 'cd y', 'for d in p q', 'cd p', 'cd q'])
    expect(p.loops).toEqual([0, 0, 1, 0, 0, 0, 0, 0])
    expect(p.compound).toEqual([false, false, true, false, true, false, false, false])
  })
})

describe('heredocs', () => {
  const cmd = (command: string): string | string[][][] => {
    const p = parseShell(command)
    return p.opaque ? `opaque: ${p.why}` : p.pipelines.map((pl) => pl.map((c) => c.argv))
  }

  test('cat and tee take the body as data', () => {
    expect(cmd("cat > f <<'EOF'\nhello $(x) `y`\nEOF")).toEqual([[['cat']]])
    expect(cmd('cat <<EOF >f\nhello\nEOF')).toEqual([[['cat']]])
    expect(cmd('cat <<-EOF > f\n\thello\n\tEOF')).toEqual([[['cat']]])
    expect(cmd('tee f <<EOF\nhello\nEOF')).toEqual([[['tee', 'f']]])
    expect(cmd('cat > f <<"EOF"\n$(x)\nEOF')).toEqual([[['cat']]])
    expect(cmd('cat > f <<\\EOF\n$(x)\nEOF')).toEqual([[['cat']]])
    expect(cmd("cat <<'A' > f && cat <<'B' > g\n1\nA\n2\nB")).toEqual([[['cat']], [['cat']]])
    expect(cmd("cat <<'A' <<'B'\n1\nA\n2\nB")).toEqual([[['cat']]])
  })

  test('the redirect is read as for any command', () => {
    const p = parseShell("cat > out.txt <<'EOF'\nx\nEOF")
    expect(!p.opaque && p.pipelines[0][0].redirects).toEqual(['out.txt'])
    const q = parseShell("cat <<'EOF' > $TEMP/o\nx\nEOF")
    expect(!q.opaque && q.pipelines[0][0].redirects).toEqual(['$TEMP/o'])
  })

  test('the body ends at the delimiter line only', () => {
    expect(cmd("cat <<'EOF'\nEOF2\n EOF\nEOF\necho after")).toEqual([[['cat']], [['echo', 'after']]])
    expect(cmd("cat <<'EOF'\r\nx\r\nEOF\r\necho after")).toEqual([[['cat']], [['echo', 'after']]])
  })

  test('other commands, here-strings, unfinished bodies and bodies that would run stay opaque', () => {
    expect(cmd('python - <<EOF\nprint(1)\nEOF')).toBe('opaque: a heredoc')
    expect(cmd('bash <<EOF\nls\nEOF')).toBe('opaque: a heredoc')
    expect(cmd('node - <<EOF\n1\nEOF')).toBe('opaque: a heredoc')
    expect(cmd('<<EOF\nx\nEOF')).toBe('opaque: a heredoc')
    expect(cmd('cat <<<hi')).toBe('opaque: a heredoc')
    expect(cmd('cat <<EOF\nx')).toBe('opaque: an unterminated heredoc')
    expect(cmd('cat <<EOF')).toBe('opaque: an unterminated heredoc')
    expect(cmd('cat <<EOF\n$(ls)\nEOF')).toBe('opaque: a heredoc whose text would run commands')
    expect(cmd('cat <<EOF\n`ls`\nEOF')).toBe('opaque: a heredoc whose text would run commands')
    expect(cmd('cat <<$X\nx\n$X')).toBe('opaque: a heredoc')
    expect(cmd('cat <<EOF | bash\nls\nEOF')).toMatch(/standard input/)
  })

  test('a heredoc keeps the command out of allow rules', () => {
    expect(plainStages("cat <<'EOF'\nx\nEOF")).toBeNull()
  })
})
