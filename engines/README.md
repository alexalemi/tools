# Chess engines

- `stockfish/`: the unmodified lite single-threaded build from npm `stockfish@19.0.1`, GPLv3 (`Copying.txt`).
  Source: https://github.com/nmrugg/stockfish.js/tree/v19.0.1 and https://github.com/official-stockfish/Stockfish
- `shannon/`: a Rust implementation of Claude Shannon's 1950 "Programming a Computer for Playing Chess",
  built in the separate `shannon-chess` project (`scripts/build-wasm.sh`). Move generation is cozy-chess (MIT).
