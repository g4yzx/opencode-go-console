'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { writeFileAtomic, rotateIfBigger, readTailText, ensureDir } = require('../src/file-util')

function scratch () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocgo-file-'))
}

test('writeFileAtomic creates the file and leaves no temp behind', () => {
  const dir = scratch()
  const file = path.join(dir, 'config.json')
  writeFileAtomic(file, '{"a":1}\n', 'utf8')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n')
  assert.deepEqual(fs.readdirSync(dir), ['config.json'])
  writeFileAtomic(file, '{"a":2}\n', 'utf8')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}\n')
  assert.deepEqual(fs.readdirSync(dir), ['config.json'])
})

test('rotateIfBigger keeps one archive and resets the live file', () => {
  const dir = scratch()
  const file = path.join(dir, 'usage-history.jsonl')
  fs.writeFileSync(file, 'x'.repeat(2048), 'utf8')
  assert.equal(rotateIfBigger(file, 1024), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.statSync(`${file}.1`).size, 2048)
  fs.writeFileSync(file, 'second generation', 'utf8')
  assert.equal(rotateIfBigger(file, 1024), false)
  assert.equal(fs.readFileSync(file, 'utf8'), 'second generation')
  // Second rotation replaces the old archive instead of piling up.
  fs.writeFileSync(file, 'y'.repeat(2048), 'utf8')
  assert.equal(rotateIfBigger(file, 1024), true)
  assert.equal(fs.statSync(`${file}.1`).size, 2048)
  assert.equal(fs.readdirSync(dir).sort().join(','), 'usage-history.jsonl.1')
})

test('readTailText keeps the whole file when it is small', () => {
  const dir = scratch()
  const file = path.join(dir, 'log.txt')
  fs.writeFileSync(file, 'a\nb\nc\n', 'utf8')
  assert.equal(readTailText(file, 4096), 'a\nb\nc\n')
})

test('readTailText drops a clipped first line', () => {
  const dir = scratch()
  const file = path.join(dir, 'log.txt')
  const lines = []
  for (let i = 0; i < 500; i++) lines.push(`line-${String(i).padStart(4, '0')}-padding`)
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  const tail = readTailText(file, 400)
  assert.ok(tail.trim().endsWith('line-0499-padding'))
  const lines2 = tail.trim().split('\n')
  assert.ok(lines2.length > 1)
  // Every retained line must be complete: a clipped head is dropped, not merged.
  for (const line of lines2) assert.match(line, /^line-\d{4}-padding$/)
})

test('ensureDir is idempotent', () => {
  const dir = scratch()
  const nested = path.join(dir, 'a', 'b')
  ensureDir(nested)
  ensureDir(nested)
  assert.ok(fs.statSync(nested).isDirectory())
})
