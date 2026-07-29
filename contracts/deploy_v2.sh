#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source .env

echo "Confirmando índice del Ledger..."
cast wallet address --ledger --mnemonic-index 2

BYTECODE=$(forge inspect src/compound/VaultFactoryArbCompoundV2.sol:VaultFactoryArbCompoundV2 bytecode)
ARGS=$(cast abi-encode "constructor(address,address,address)" \
  0xCF281b7bc1dEd843542008a577D7bdaa8F41B0Cb \
  0xC36442b4a4522E871399CD717aBDD847Ab11FE88 \
  0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45)
FULL="${BYTECODE}${ARGS#0x}"

echo "Deployando VaultFactoryArbCompoundV2 a Arbitrum — confirmá en el Ledger cuando te lo pida..."
cast send --ledger --mnemonic-index 2 --rpc-url "$ARBITRUM_RPC_URL" --create "$FULL"
