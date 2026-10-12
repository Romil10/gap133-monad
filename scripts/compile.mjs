// Compiles the contract with solc-js and writes ABI + bytecode to
// public/contract.json (the deploy page and the server both read it).
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const source = readFileSync('contracts/GapGame.sol', 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'GapGame.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join('\n'));
  process.exit(1);
}
const c = out.contracts['GapGame.sol'].GapGame;
mkdirSync('public', { recursive: true });
writeFileSync(
  'public/contract.json',
  JSON.stringify(
    { compiler: solc.version(), evmVersion: 'paris', optimizerRuns: 200, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object },
    null,
    1,
  ),
);
console.log('compiled', solc.version(), 'bytecode bytes:', c.evm.bytecode.object.length / 2);
