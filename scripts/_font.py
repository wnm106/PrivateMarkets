from PIL import Image

files = {
    "mock": r"C:\Users\billm\.cursor\projects\c-Users-billm-Private-Markets-tapestrai\assets\c__Users_billm_AppData_Roaming_Cursor_User_workspaceStorage_7cfcf6057eb683ffd5a375a349be0449_images_image-40f32a21-f5fa-48d3-a144-31f6482ba49b.png",
    "app": r"C:\Users\billm\.cursor\projects\c-Users-billm-Private-Markets-tapestrai\assets\c__Users_billm_AppData_Roaming_Cursor_User_workspaceStorage_7cfcf6057eb683ffd5a375a349be0449_images_image-3bdea089-7aaf-467e-9946-8adf8b303906.png",
}

def rules(path):
    im = Image.open(path).convert("RGB")
    px = im.load()
    w, h = im.size
    found = []
    for y in range(40, h - 2):
        line = 0
        for x in range(180, min(w - 20, 900), 3):
            r, g, b = px[x, y]
            if 190 < min(r, g, b) < 245 and max(r, g, b) - min(r, g, b) < 20:
                line += 1
        if line > 70:
            found.append(y)
    bands = []
    if found:
        start = prev = found[0]
        for y in found[1:]:
            if y <= prev + 1:
                prev = y
            else:
                bands.append(start)
                start = prev = y
        bands.append(start)
    gaps = [bands[i + 1] - bands[i] for i in range(len(bands) - 1)]
    print(path.split("image-")[-1][:8], "w", w, "rules", len(bands), "gaps", gaps[:20])

for path in files.values():
    rules(path)
