"""AirDraft Studio desktop application."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from uuid import uuid4

import cv2
import numpy as np
from PIL import Image, ImageTk

from models import build_model

LABELS = ("stickman", "house", "fish", "bird", "tree", "flower")
FORMAT = "airdraft-sketches-v1"
INK = "#cbbaff"
BACKGROUND = "#191827"


def write_dataset(path, samples):
    dataset = {"format": FORMAT, "coordinates": "Normalized canvas x,y. Origin at top-left.", "samples": samples}
    path.write_text(json.dumps(dataset, indent=2)+"\n", encoding="utf-8")


def read_dataset(path):
    dataset = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(dataset, dict) or dataset.get("format") != FORMAT or not isinstance(dataset.get("samples"), list):
        raise ValueError("Choose an AirDraft dataset JSON file.")
    samples = dataset["samples"]
    for sample in samples:
        if sample["label"] not in LABELS or min(sample["canvas"]["width"], sample["canvas"]["height"]) <= 0:
            raise ValueError("Invalid sketch label or canvas size.")
        if not sample["strokes"]:
            raise ValueError("A sketch has no strokes.")
        for stroke in sample["strokes"]:
            if not stroke["points"] or any(len(p) != 2 or not all(0 <= v <= 1 for v in p) for p in stroke["points"]):
                raise ValueError("Invalid stroke coordinates.")
    return samples


class Pinch:
    def __init__(self):
        self.reset()

    def reset(self):
        self.armed = self.drawing = False

    def update(self, ratio):
        if ratio is None:
            self.reset()
        elif ratio >= .25:
            self.drawing = False
            self.armed = True
        elif self.armed and ratio < .18:
            self.drawing = True
        return self.drawing


def draw_strokes(canvas, strokes, width, height, left=0, top=0, tag="ink"):
    canvas.delete(tag)
    for stroke in strokes:
        points = [(left+x*width, top+y*height) for x,y in stroke["points"]]
        if len(points) == 1:
            x, y = points[0]
            canvas.create_oval(x-2,y-2,x+2,y+2,fill=INK,outline="",tags=tag)
        else:
            canvas.create_line(*[v for point in points for v in point],fill=INK,width=4,capstyle=tk.ROUND,
                               joinstyle=tk.ROUND,tags=tag)


def render_mesh(mesh, yaw, pitch, width, height):
    image = np.full((height,width,3),(35,31,36),dtype=np.uint8)
    cy, sy = np.cos(yaw), np.sin(yaw)
    cx, sx = np.cos(pitch), np.sin(pitch)
    rotation = np.array([[cy,0,sy],[0,1,0],[-sy,0,cy]]) @ np.array([[1,0,0],[0,cx,-sx],[0,sx,cx]])
    vertices = mesh.vertices @ rotation
    normals = mesh.face_normals @ rotation
    scale = min(width,height)*.80/max(np.linalg.norm(mesh.extents),1)
    screen = (vertices[:, :2]*[scale,-scale]+[width/2,height/2]).astype(np.int32)
    triangles = vertices[mesh.faces]
    shade = np.clip(103 + 136*(normals@[-.34,.50,.79]),76,239).astype(int)
    for i in np.argsort(triangles[:, :, 2].mean(axis=1)):
        if normals[i, 2] > 0:
            value = int(shade[i])
            cv2.fillConvexPoly(image,screen[mesh.faces[i]],(value,value,value),cv2.LINE_AA)
    return Image.fromarray(image)


class AirDraft:
    def __init__(self, root, camera_index, data_path):
        self.root, self.camera_index, self.data_path = root, camera_index, data_path
        self.strokes, self.history, self.active = [], [], None
        self.pointer_down = False
        self.cursor = self.smooth = self.erase_from = None
        self.pinch = Pinch()
        self.capture = self.tracker = self.camera_job = None
        self.samples = []
        self.session_id = str(uuid4())
        self.mesh = self.drag_origin = None
        self.yaw, self.pitch = .34, .17
        root.title("AirDraft Studio · Python")
        root.geometry("1120x700")
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.columnconfigure((0,1),weight=1,uniform="panel")
        root.rowconfigure(1,weight=1)

        self.status = tk.StringVar(value="Mouse drag to draw, or enable the camera.")
        self.mode = tk.StringVar(value="Stick figure")
        self.label = tk.StringVar(value=LABELS[0])
        self.erase = tk.BooleanVar()
        self.count = tk.StringVar()
        header = ttk.Frame(root,padding=(12,10))
        header.grid(row=0,column=0,columnspan=2,sticky="ew")
        self.camera_button = ttk.Button(header,text="Enable camera",command=self.toggle_camera)
        self.camera_button.pack(side="left")
        ttk.Checkbutton(header,text="Eraser",variable=self.erase,command=self.end_gesture).pack(side="left",padx=8)
        ttk.Button(header,text="Undo",command=self.undo).pack(side="left")
        ttk.Button(header,text="Clear",command=self.clear).pack(side="left",padx=6)
        ttk.Button(header,text="Load example",command=self.load_example).pack(side="left")
        ttk.Label(header,textvariable=self.status,wraplength=430).pack(side="left",padx=12)

        self.canvas = tk.Canvas(root,bg=BACKGROUND,highlightthickness=0)
        self.canvas.grid(row=1,column=0,sticky="nsew",padx=(12,6))
        self.canvas.bind("<Configure>",lambda event:self.paint())
        self.canvas.bind("<ButtonPress-1>",self.pointer_start)
        self.canvas.bind("<B1-Motion>",self.pointer_move)
        self.canvas.bind("<Motion>",self.pointer_hover)
        self.canvas.bind("<ButtonRelease-1>",self.pointer_end)
        self.canvas.bind("<Leave>",self.pointer_leave)

        self.preview = tk.Canvas(root,bg="#232027",highlightthickness=0)
        self.preview.grid(row=1,column=1,sticky="nsew",padx=(6,12))
        self.preview.create_text(20,24,anchor="w",text="Generate a model to preview it here.",fill="white")
        self.preview.bind("<Configure>",lambda event:self.paint_model())
        self.preview.bind("<ButtonPress-1>",lambda event:setattr(self,"drag_origin",(event.x,event.y)))
        self.preview.bind("<B1-Motion>",self.rotate)

        left = ttk.Frame(root,padding=(12,10))
        left.grid(row=2,column=0,sticky="w")
        ttk.Combobox(left,textvariable=self.label,values=LABELS,state="readonly",width=9).pack(side="left")
        ttk.Button(left,text="Save sketch",command=self.save).pack(side="left",padx=5)
        ttk.Button(left,text="Export JSON",command=self.export_dataset).pack(side="left")
        ttk.Button(left,text="Review JSON",command=self.review).pack(side="left",padx=5)
        ttk.Label(left,textvariable=self.count).pack(side="left")
        right = ttk.Frame(root,padding=(6,10))
        right.grid(row=2,column=1,sticky="w")
        ttk.Combobox(right,textvariable=self.mode,values=("Stick figure","House"),state="readonly",width=12).pack(side="left")
        ttk.Button(right,text="Generate 3D",command=self.generate).pack(side="left",padx=5)
        ttk.Button(right,text="Export OBJ",command=self.export_model).pack(side="left")
        if data_path.exists():
            try:
                self.samples = read_dataset(data_path)
            except (OSError,ValueError,TypeError,KeyError) as error:
                self.status.set(f"Could not read local dataset. {error}")
                self.data_path = data_path.with_name(data_path.stem+"-"+self.session_id[:8]+".json")
        self.update_count()

    def size(self):
        return self.canvas.winfo_width(),self.canvas.winfo_height()

    def paint(self):
        width, height = self.size()
        draw_strokes(self.canvas,self.strokes,width,height)
        self.canvas.delete("cursor")
        if self.cursor is not None:
            x,y = self.cursor*[width,height]
            radius = 16 if self.erase.get() else 6
            self.canvas.create_oval(x-radius,y-radius,x+radius,y+radius,outline="#ffd49c",
                                    fill="#cbbaff" if self.pinch.drawing and not self.erase.get() else "",
                                    width=2,tags="cursor")

    def edit(self, point, source, begin):
        if begin:
            self.history.append(self.strokes.copy())
            if self.erase.get():
                self.erase_from = point
            else:
                self.active = {"source": source, "points":[point.tolist()]}
                self.strokes.append(self.active)
        if self.erase.get() and self.erase_from is not None:
            size = np.array(self.size())
            previous, current = self.erase_from*size, point*size
            delta = current-previous
            length = delta@delta
            remaining = []
            for stroke in self.strokes:
                chunk = []
                for sample in stroke["points"]:
                    offset = np.asarray(sample)*size-previous
                    closest = delta*np.clip((offset@delta)/length,0,1) if length else 0
                    if np.linalg.norm(offset-closest) <= 16:
                        if chunk:
                            remaining.append({**stroke,"points":chunk})
                            chunk = []
                    else:
                        chunk.append(sample)
                if chunk:
                    remaining.append({**stroke,"points":chunk})
            self.strokes = remaining
            self.erase_from = point
        elif self.active is not None and not begin:
            previous = np.asarray(self.active["points"][-1])
            distance = np.linalg.norm((point-previous)*self.size())
            if distance >= 3:
                self.active["points"].extend(p.tolist() for p in np.linspace(previous,point,int(np.ceil(distance/5))+1)[1:])
        self.paint()

    def pointer_point(self,event):
        return np.clip(np.array([event.x,event.y])/np.maximum(self.size(),1),0,1)

    def pointer_start(self,event):
        self.end_gesture()
        self.pointer_down = True
        self.cursor = self.pointer_point(event)
        self.edit(self.cursor,"mouse",True)

    def pointer_move(self,event):
        self.cursor = self.pointer_point(event)
        if self.pointer_down:
            self.edit(self.cursor,"mouse",False)

    def pointer_hover(self,event):
        if self.erase.get() and self.capture is None and not self.pointer_down:
            self.cursor = self.pointer_point(event)
            self.paint()

    def pointer_end(self,event):
        self.pointer_down = False
        self.active = self.erase_from = self.cursor = None
        self.paint()

    def pointer_leave(self,event):
        if not self.pointer_down and self.capture is None:
            self.cursor = None
            self.paint()

    def end_gesture(self):
        self.active = self.erase_from = None
        self.pointer_down = False
        self.pinch.reset()

    def undo(self):
        self.end_gesture()
        if self.history:
            self.strokes = self.history.pop()
        self.paint()

    def clear(self):
        self.end_gesture()
        if self.strokes:
            self.history.append(self.strokes)
        self.strokes = []
        self.paint()

    def load_example(self):
        self.clear()
        if self.mode.get()=="House":
            paths = [[(.29,.46),(.5,.23),(.71,.46),(.71,.77),(.29,.77),(.29,.46)]]
        else:
            aspect = self.size()[0]/max(self.size()[1],1)
            paths = [[(.5+.08*np.sin(i*np.pi/20)/max(aspect,.5),.245+.08*np.cos(i*np.pi/20)) for i in range(41)],
                     [(.5,.325),(.5,.62)],[(.222,.392),(.5,.377),(.778,.392)],
                     [(.425,.825),(.5,.62),(.575,.825)]]
        self.strokes = [{"source":"example","points":path} for path in paths]
        self.paint()
        self.generate()

    def toggle_camera(self):
        if self.capture is not None:
            self.stop_camera()
            return
        capture = cv2.VideoCapture(self.camera_index)
        if not capture.isOpened():
            capture.release()
            self.status.set("Could not open the webcam. Mouse drawing is available.")
            return
        try:
            from mediapipe import solutions
            self.tracker = solutions.hands.Hands(max_num_hands=1,min_detection_confidence=.60,min_tracking_confidence=.60)
        except (ImportError,RuntimeError,ValueError) as error:
            capture.release()
            self.status.set(f"Hand tracking could not start. {error}")
            return
        self.capture = capture
        self.camera_button.configure(text="Stop camera")
        self.camera_tick()

    def camera_tick(self):
        self.camera_job = None
        ok, frame = self.capture.read()
        if not ok:
            self.stop_camera()
            self.status.set("Webcam feed stopped.")
            return
        try:
            hands = self.tracker.process(cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)).multi_hand_landmarks
            if hands and not self.pointer_down:
                marks = hands[0].landmark
                aspect = frame.shape[1]/frame.shape[0]
                def distance(first,second):
                    return np.hypot((first.x-second.x)*aspect,first.y-second.y)
                tip, thumb = marks[8],marks[4]
                palm = distance(marks[0],marks[9])
                point = np.clip(np.array([.9-tip.x,tip.y-.1])/.8,0,1)
                self.smooth = point if self.smooth is None else .45*self.smooth+.55*point
                self.cursor = self.smooth
                was_drawing = self.pinch.drawing
                if self.pinch.update(distance(tip,thumb)/palm if palm>.015 else None):
                    self.edit(self.smooth,"camera",not was_drawing)
                    self.status.set("Erasing" if self.erase.get() else "Drawing")
                else:
                    self.active = self.erase_from = None
                    self.status.set("Hovering · pinch to edit" if self.pinch.armed else "Separate thumb and index finger to aim.")
                    self.paint()
            elif not self.pointer_down:
                self.end_gesture()
                self.cursor = self.smooth = None
                self.status.set("Show one hand to the webcam.")
                self.paint()
        except (RuntimeError,ValueError) as error:
            self.stop_camera()
            self.status.set(f"Hand tracking stopped. {error}")
            return
        self.camera_job = self.root.after(20,self.camera_tick)

    def stop_camera(self):
        if self.camera_job is not None:
            self.root.after_cancel(self.camera_job)
            self.camera_job = None
        if self.capture is not None:
            self.capture.release()
        if self.tracker is not None:
            self.tracker.close()
        self.capture = self.tracker = self.cursor = self.smooth = None
        self.end_gesture()
        self.camera_button.configure(text="Enable camera")
        self.status.set("Mouse drag to draw, or enable the camera.")
        self.paint()

    def close(self):
        self.stop_camera()
        self.root.destroy()

    def update_count(self):
        self.count.set(f"{len(self.samples)} saved")

    def save(self):
        if not self.strokes or any(stroke["source"]=="example" for stroke in self.strokes):
            self.status.set("Draw your own sketch before saving a training sample.")
            return
        width,height = self.size()
        record = {"id":str(uuid4()),"createdAt":datetime.now(timezone.utc).isoformat(),
                  "sessionId":self.session_id,"label":self.label.get(),"canvas":{"width":width,"height":height},
                  "strokes":self.strokes}
        temporary = self.data_path.with_suffix(".tmp")
        try:
            self.data_path.parent.mkdir(parents=True,exist_ok=True)
            write_dataset(temporary,[*self.samples,record])
            temporary.replace(self.data_path)
        except OSError as error:
            self.status.set(f"Could not save sketch. {error}")
            return
        self.samples.append(record)
        self.update_count()
        self.end_gesture()
        self.strokes = []
        self.history.clear()
        self.paint()
        self.status.set(f"Saved {record['label']} sketch.")

    def export_dataset(self):
        if self.samples:
            export_samples(self.root,self.samples,"airdraft-sketches.json")
        else:
            self.status.set("Save a sketch before exporting.")

    def review(self):
        filename = filedialog.askopenfilename(parent=self.root,filetypes=[("AirDraft JSON","*.json")])
        if filename:
            try:
                samples = read_dataset(Path(filename))
                if not samples:
                    raise ValueError("The dataset is empty.")
                Review(self.root,samples)
            except (OSError,ValueError,TypeError,KeyError) as error:
                messagebox.showerror("Dataset review",str(error),parent=self.root)

    def generate(self):
        try:
            self.mesh = build_model(self.strokes,self.size(),self.mode.get())
        except (OSError,ValueError) as error:
            self.status.set(str(error))
            return
        self.paint_model()
        self.status.set("Model ready. Drag the model to rotate.")

    def paint_model(self):
        if self.mesh is None:
            return
        image = render_mesh(self.mesh,self.yaw,self.pitch,max(1,self.preview.winfo_width()),max(1,self.preview.winfo_height()))
        self.model_image = ImageTk.PhotoImage(image)
        self.preview.delete("all")
        self.preview.create_image(0,0,anchor="nw",image=self.model_image)

    def rotate(self,event):
        if self.drag_origin is None or self.mesh is None:
            return
        x,y = self.drag_origin
        self.yaw += (event.x-x)*.013
        self.pitch = np.clip(self.pitch+(event.y-y)*.013,-1.3,1.3)
        self.drag_origin = event.x,event.y
        self.paint_model()

    def export_model(self):
        if self.mesh is None:
            self.status.set("Generate a model first.")
            return
        filename = filedialog.asksaveasfilename(parent=self.root,defaultextension=".obj",filetypes=[("Wavefront OBJ","*.obj")])
        if filename:
            try:
                self.mesh.export(filename,include_color=False,include_texture=False)
            except OSError as error:
                messagebox.showerror("OBJ export",str(error),parent=self.root)


def export_samples(parent,samples,name):
    output = filedialog.asksaveasfilename(parent=parent,initialfile=name,defaultextension=".json",
                                         filetypes=[("AirDraft JSON","*.json")])
    if output:
        try:
            write_dataset(Path(output),samples)
        except OSError as error:
            messagebox.showerror("Dataset export",str(error),parent=parent)


class Review:
    def __init__(self,parent,samples):
        self.samples, self.decisions, self.index = samples, {}, 0
        self.window = tk.Toplevel(parent)
        self.window.title("AirDraft · Dataset review")
        self.window.geometry("665x420")
        self.window.rowconfigure(0,weight=1)
        self.window.columnconfigure(0,weight=1)
        self.canvas = tk.Canvas(self.window,bg=BACKGROUND,highlightthickness=0)
        self.canvas.grid(row=0,column=0,sticky="nsew",padx=10,pady=10)
        self.canvas.bind("<Configure>",lambda event:self.paint())
        controls = ttk.Frame(self.window,padding=10)
        controls.grid(row=1,column=0,sticky="ew")
        self.label = tk.StringVar()
        self.info = tk.StringVar()
        ttk.Label(controls,textvariable=self.info).pack(anchor="w",pady=4)
        ttk.Combobox(controls,textvariable=self.label,values=LABELS,state="readonly",width=9).pack(side="left")
        for text,command in (
            ("Previous",lambda:self.move(-1)),("Next",lambda:self.move(1)),
            ("Approve",lambda:self.decide(True)),("Exclude",lambda:self.decide(False)),("Export reviewed",self.export)
        ):
            ttk.Button(controls,text=text,command=command).pack(side="left",padx=4)
        self.move(0)

    def paint(self):
        sw,sh = (self.samples[self.index]["canvas"][key] for key in ("width","height"))
        width,height = self.canvas.winfo_width(),self.canvas.winfo_height()
        scale = .9*min(width/sw,height/sh)
        draw_strokes(self.canvas,self.samples[self.index]["strokes"],sw*scale,sh*scale,
                     (width-sw*scale)/2,(height-sh*scale)/2)

    def move(self,delta):
        self.index = int(np.clip(self.index+delta,0,len(self.samples)-1))
        original = self.samples[self.index]["label"]
        accepted, corrected = self.decisions.get(self.index,(None,original))
        self.label.set(corrected)
        decision = {None:"unreviewed",True:"approved",False:"excluded"}[accepted]
        self.info.set(f"Sketch {self.index+1} of {len(self.samples)} · Original label: {original} · {decision}")
        self.paint()

    def decide(self,accepted):
        self.decisions[self.index] = accepted,self.label.get()
        self.move(1)

    def export(self):
        approved = [{**self.samples[i],"label":label} for i,(keep,label) in sorted(self.decisions.items()) if keep]
        if approved:
            export_samples(self.window,approved,"airdraft-reviewed.json")
        else:
            messagebox.showinfo("Dataset review","Approve at least one sketch before exporting.",parent=self.window)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera",type=int,default=0,help="OpenCV camera index")
    parser.add_argument("--data",type=Path,default=Path.home()/".airdraft"/"sketches.json",help="Local dataset file")
    args = parser.parse_args()
    root = tk.Tk()
    AirDraft(root,args.camera,args.data)
    root.mainloop()


if __name__ == "__main__":
    main()
