from pathlib import Path

from PIL import Image


SRC = Path(
    r"C:\Users\PC\.codex\generated_images\019e8d60-5c83-7553-8148-e71d9a586aad\ig_06eed16ba2c5da0b016a20fc9b6fa8819180e8f40bb463a961.png"
)
RES = Path(r"D:\inkos-apk\packages\studio\android\app\src\main\res")
PREVIEW = RES / "drawable" / "inkos_icon_option_4.png"


def main() -> None:
    image = Image.open(SRC).convert("RGBA")
    icon = image.crop((120, 526, 500, 906)).resize((1024, 1024), Image.Resampling.LANCZOS)
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    icon.save(PREVIEW)

    legacy_sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    adaptive_sizes = {
        "mipmap-mdpi": 108,
        "mipmap-hdpi": 162,
        "mipmap-xhdpi": 216,
        "mipmap-xxhdpi": 324,
        "mipmap-xxxhdpi": 432,
    }

    for folder, size in legacy_sizes.items():
        resized = icon.resize((size, size), Image.Resampling.LANCZOS)
        target = RES / folder
        resized.save(target / "ic_launcher.png")
        resized.save(target / "ic_launcher_round.png")

    for folder, size in adaptive_sizes.items():
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        inner = int(size * 0.88)
        resized = icon.resize((inner, inner), Image.Resampling.LANCZOS)
        offset = ((size - inner) // 2, (size - inner) // 2)
        canvas.alpha_composite(resized, offset)
        canvas.save(RES / folder / "ic_launcher_foreground.png")

    print(f"generated {PREVIEW}")


if __name__ == "__main__":
    main()
