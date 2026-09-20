# ero.dance Converter

This project is a browser-based converter for MMD assets and ero.dance image cards.

It can convert the following formats:

- `ero.dance Image Cards` <-> `MMD assets and metadata`
- `PMX <-> BPMX`
- `VMD`, `VPD`, `VMP` <-> `BVMD`
- `WAV`, `MP3` -> `WebM`

The converter is available at:

- https://convert.ero.dance

The generated image cards are usable at:

- https://ero.dance

Documentation is available at:

- https://docs.ero.dance

## Development

Install dependencies and run the local app with Bun:

```bash
bun install
bun run dev
```

Useful commands:

- `bun run build` builds the project for production
- `bun run test:run` runs the test suite once
- `bun run lint` runs ESLint

## CLI Tool

The converter can also be used via the command line.

### Usage

```bash
# General usage
bun run cli.ts <command> <input> [options]

# Create a card from a PMX model (automatically finds textures in the folder)
bun run cli.ts card-create model.pmx -o card.png

# Create a card from a ZIP file containing everything
bun run cli.ts card-create model.zip

# Convert PMX to BPMX
bun run cli.ts pmx-to-bpmx model.pmx

# Extract files from a card
bun run cli.ts card-extract card.png
```

If multiple model files are found in a folder or ZIP, the CLI will interactively ask which one to use.

### Commands

- `bpmx-to-pmx <file>`: Convert BPMX model to PMX (output: ZIP)
- `pmx-to-bpmx <file>`: Convert PMX model to BPMX (reads textures from same directory or ZIP)
- `motion-to-bvmd <files...>`: Convert VMD/VPD/VMP motion(s) to BVMD; multiple `.vmd` files (model + camera) are merged into one BVMD
- `bvmd-to-vmd <file>`: Convert BVMD motion to VMD (model + camera as separate files; `--combined` for a single file)
- `audio-to-webm <file>`: Convert WAV/MP3 audio to WebM (Opus)
- `card-extract <file>`: Extract files from an ero.dance card PNG
- `card-create <files...>`: Create an ero.dance card PNG from input files, folders, or ZIPs

### Options

- `-o, --output <path>`: Output file path
- `--verbose`: Show detailed conversion report
- `--compression <mode>`: Image compression: `lossless` (default), `lossy`, `raw`
- `--force-avif`: Force real AVIF output via @jsquash/avif
- `--base-image <path>`: Path to base image for the card PNG

## License

This converter is licensed under the MIT License.
