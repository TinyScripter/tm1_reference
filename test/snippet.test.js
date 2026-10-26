'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildSnippet, buildExampleSnippet } = require('../src/snippet');
const { loadSection } = require('../src/lib');
const fs = require('fs');
const DATA = path.join(__dirname, '..', 'data');
const needData = fs.existsSync(path.join(DATA, 'en', 'ti.json')) && fs.existsSync(path.join(DATA, 'de', 'ti.json')) ? false : 'run "npm run fetch-docs" first';

const ti = (s) => buildSnippet(s, { section: 'ti' });

test('simple call: one tab stop per argument, final stop, semicolon kept', () => {
  assert.strictEqual(
    ti('CellPutN(x, Cube, e1, e2 [,..., en]);'),
    'CellPutN(${1:x}, ${2:Cube}, ${3:e1}, ${4:e2});$0'
  );
  assert.strictEqual(ti('SubsetMDXSet(DimName, SubName, MDX_expression);'), 'SubsetMDXSet(${1:DimName}, ${2:SubName}, ${3:MDX_expression});$0');
});

test('optional trailing arguments ([..] and <..>) are dropped', () => {
  assert.strictEqual(ti('ATTRNL(DimName, ElName, AttrName, [LangLocaleCode]);'), 'ATTRNL(${1:DimName}, ${2:ElName}, ${3:AttrName});$0');
  assert.strictEqual(ti('FormatDate(Date, <Pattern>, <Index>)'), 'FormatDate(${1:Date})$0');
});

test('an optional argument followed by a required one stays', () => {
  assert.strictEqual(ti('F(a, [b], c)'), 'F(${1:a}, ${2:b}, ${3:c})$0');
});

test('repetition notation is cut off', () => {
  assert.strictEqual(ti('ASCIIOutput(FileName, String1, String2, ...Stringn);'), 'ASCIIOutput(${1:FileName}, ${2:String1}, ${3:String2});$0');
  assert.strictEqual(ti('CellPutProportionalSpread( value, cube, e1, e2, e3...,en );'), 'CellPutProportionalSpread(${1:value}, ${2:cube}, ${3:e1}, ${4:e2}, ${5:e3});$0');
  assert.strictEqual(buildSnippet('DB(cube, e1, e2, [...e256])', { section: 'rules' }), 'DB(${1:cube}, ${2:e1}, ${3:e2})$0');
});

test('rules functions are expressions: trailing semicolon dropped', () => {
  assert.strictEqual(buildSnippet('CellValueN(cube, element1,..., elementN);', { section: 'rules' }), 'CellValueN(${1:cube}, ${2:element1})$0');
  assert.strictEqual(buildSnippet('CellValueN(cube, element1,..., elementN);', { section: 'ti' }), 'CellValueN(${1:cube}, ${2:element1});$0');
});

test('call wrapped over several lines / with continuation / annotation', () => {
  assert.match(ti('F(a, b, \nc, d);'), /^F\(\$\{1:a\}, \$\{2:b\}, \$\{3:c\}, \$\{4:d\}\);\$0$/);
  assert.strictEqual(ti('F(a, b, \\\nc);'), 'F(${1:a}, ${2:b}, ${3:c});$0');
  assert.strictEqual(ti('CubeDataReservationGet(Index, Cube, User, [AddressDelimiter]) returns Address;'), 'CubeDataReservationGet(${1:Index}, ${2:Cube}, ${3:User});$0');
});

test('several variants of the same call: first one is used', () => {
  assert.strictEqual(ti('ServerSandboxGet( index )\nServerSandboxGet( index, username)'), 'ServerSandboxGet(${1:index})$0');
  assert.strictEqual(ti('ServerSandboxListCountGet()\nServerSandboxListCountGet( username )'), 'ServerSandboxListCountGet()$0');
});

test('not a plain call -> null (inserted unchanged)', () => {
  for (const s of ['ChoreQuit;', 'SetODBCUnicodeInterface=1', 'TM1User()', 'ISLEAF', '', null,
    'If(expression);\nstatement1;\nElse;\nstatement2;\nEndIf;',
    'WHILE(logical expression);\n\nstatement1;\n\nEND;',
    'EnableBulkLoadMode();\nDisableBulkLoadMode();', 'F(unclosed']) {
    assert.strictEqual(ti(s), null, String(s));
  }
});

test('commas and parentheses inside an argument do not split it; snippet characters are escaped', () => {
  assert.strictEqual(ti("X(a, 'b,c', f(d, e))"), "X(${1:a}, ${2:'b,c'}, ${3:f(d, e)})$0");
  assert.strictEqual(ti('X(a$b, c})'), 'X(${1:a\\$b}, ${2:c\\}})$0');
});

for (const lang of ['en', 'de']) {
  test(`every downloaded syntax line (${lang}) yields null or a well-formed snippet`, { skip: needData }, () => {
    let snippets = 0;
    for (const section of ['ti', 'rules']) {
      for (const e of loadSection(DATA, lang, section).entries) {
        if (!e.syntax) continue;
        const s = buildSnippet(e.syntax, { section });
        if (s === null) continue;
        snippets++;
        const stops = [...s.matchAll(/\$\{(\d+):/g)].map((m) => Number(m[1]));
        assert.deepStrictEqual(stops, stops.map((_, i) => i + 1), `${section}/${e.name}: ${s}`);
        assert.ok(s.endsWith('$0'), `${e.name}: ${s}`);
        assert.ok(!/\$\{\d+:\}/.test(s) && !/\.\.\./.test(s), `${e.name}: ${s}`);
        assert.ok(s.startsWith(e.syntax.trim().match(/^[\w.]+/)[0] + '('), `${e.name}: ${s}`);
      }
    }
    assert.ok(snippets > 300, `only ${snippets} snippets`);
  });
}

// ---- examples -------------------------------------------------------------------------------

/** Inverse of the snippet escaping: what the editor shows once all stops keep their default text. */
const plainOf = (s) =>
  s.replace(/\$\{\d+:((?:\\.|[^}\\])*)\}/g, '$1').replace(/\$0$/, '').replace(/\\([\\$}])/g, '$1');

test('example: every argument becomes a stop, quotes of text values stay outside', () => {
  assert.strictEqual(
    buildExampleSnippet("CellPutN(12345, 'y2ksales', 'Actual', 'S Series 1.8L Sedan');", ['CellPutN']),
    "CellPutN(${1:12345}, '${2:y2ksales}', '${3:Actual}', '${4:S Series 1.8L Sedan}');$0"
  );
});

test('example: expressions, variables and nested calls are one stop each', () => {
  assert.strictEqual(
    buildExampleSnippet("CellPutN(nV * 2, 'Cube', 'a' | vB, NumberToString(1, 2));", ['CellPutN']),
    "CellPutN(${1:nV * 2}, '${2:Cube}', ${3:'a' | vB}, ${4:NumberToString(1, 2)});$0"
  );
});

test('example: only calls of the documented function; comments, strings and other calls stay', () => {
  const code = "# CellPutN('x', 1);\ns = 'CellPutN(1)';\nOther('a');\nnV = cellgetn('Sales', 'A');";
  assert.strictEqual(
    buildExampleSnippet(code, ['CellGetN']),
    "# CellPutN('x', 1);\ns = 'CellPutN(1)';\nOther('a');\nnV = cellgetn('${1:Sales}', '${2:A}');$0"
  );
});

test('example: several calls are numbered continuously', () => {
  assert.strictEqual(
    buildExampleSnippet("F(1, 'a');\nF(2, 'b');", ['f']),
    "F(${1:1}, '${2:a}');\nF(${3:2}, '${4:b}');$0"
  );
});

test('example: escaping of backslash, dollar and quotes inside strings', () => {
  assert.strictEqual(buildExampleSnippet("F('C:\\temp\\a.csv', 'it''s', '', \"d\");", ['F']), "F('${1:C:\\\\temp\\\\a.csv}', '${2:it''s}', '${3:}', \"${4:d}\");$0");
  assert.strictEqual(buildExampleSnippet("F('a$b'); x = '$';", ['F']), "F('${1:a\\$b}'); x = '\\$';$0");
});

test('example: nothing to do -> null', () => {
  assert.strictEqual(buildExampleSnippet('ChoreQuit;', ['ChoreQuit']), null);
  assert.strictEqual(buildExampleSnippet('TM1User()', ['TM1User']), null);
  assert.strictEqual(buildExampleSnippet("Other('a');", ['F']), null);
  assert.strictEqual(buildExampleSnippet("F('a');", []), null);
  assert.strictEqual(buildExampleSnippet('', ['F']), null);
});

for (const lang of ['en', 'de']) {
  test(`all downloaded examples (${lang}): snippet reproduces the original code exactly, stops numbered 1..n`, { skip: needData }, () => {
    let converted = 0;
    let total = 0;
    for (const section of ['ti', 'rules']) {
      for (const e of loadSection(DATA, lang, section).entries) {
        const syntaxName = /^\s*([A-Za-z_]\w*)\s*\(/.exec(e.syntax || '');
        for (const ex of e.examples || []) {
          total++;
          const s = buildExampleSnippet(ex.code, [e.name, syntaxName && syntaxName[1]]);
          if (s === null) continue;
          converted++;
          assert.strictEqual(plainOf(s), ex.code, `${section}/${e.name}`);
          const stops = [...s.matchAll(/\$\{(\d+):/g)].map((m) => Number(m[1]));
          assert.deepStrictEqual(stops, stops.map((_, i) => i + 1), `${section}/${e.name}: ${s}`);
          assert.ok(s.endsWith('$0'));
        }
      }
    }
    assert.ok(converted > 200 && total > converted, `${converted} of ${total}`);
  });
}
