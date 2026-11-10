from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def main():
    source = Path(__file__).resolve().parent
    output = source / "dist" / "paper-digest-reading-draft.xpi"
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name in ("manifest.json", "bootstrap.js"):
            archive.write(source / name, name)
    print(output)


if __name__ == "__main__":
    main()
