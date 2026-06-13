import os
import sys
import sqlite3
import hashlib
import shutil
import json
import threading
from datetime import datetime
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from PIL import Image, ImageTk

try:
    from flask import Flask, request, jsonify, send_file
    from flask_cors import CORS
    HAS_FLASK = True
except ImportError:
    HAS_FLASK = False

class DatabaseAPI:
    def __init__(self, db_path):
        self.db_path = db_path
        self.app = Flask(__name__)
        CORS(self.app)
        self.setup_routes()
    
    def get_connection(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn
    
    def setup_routes(self):
        @self.app.route('/api/files', methods=['GET'])
        def get_files():
            conn = self.get_connection()
            cursor = conn.cursor()
            
            folder_id = request.args.get('folder_id')
            search = request.args.get('search')
            limit = request.args.get('limit', 100, type=int)
            offset = request.args.get('offset', 0, type=int)
            
            query = "SELECT * FROM files WHERE 1=1"
            params = []
            
            if folder_id:
                query += " AND folder_id = ?"
                params.append(folder_id)
            
            if search:
                query += " AND (filename LIKE ? OR tags LIKE ? OR notes LIKE ?)"
                params.extend([f'%{search}%'] * 3)
            
            query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            
            cursor.execute(query, params)
            files = [dict(row) for row in cursor.fetchall()]
            
            cursor.execute("SELECT COUNT(*) as total FROM files")
            total = cursor.fetchone()['total']
            
            conn.close()
            return jsonify({"files": files, "total": total})
        
        @self.app.route('/api/files/<int:file_id>', methods=['GET'])
        def get_file(file_id):
            conn = self.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
            file = cursor.fetchone()
            conn.close()
            
            if file:
                return jsonify(dict(file))
            return jsonify({"error": "File not found"}), 404
        
        @self.app.route('/api/files', methods=['POST'])
        def upload_file():
            if 'file' not in request.files:
                return jsonify({"error": "No file"}), 400
            
            file = request.files['file']
            folder_id = request.form.get('folder_id')
            tags = request.form.get('tags', '')
            notes = request.form.get('notes', '')
            
            filename = file.filename
            file_ext = os.path.splitext(filename)[1].lower().replace('.', '')
            
            file_data = file.read()
            file_hash = hashlib.md5(file_data).hexdigest()
            file_size = len(file_data)
            
            files_dir = "stored_files"
            os.makedirs(files_dir, exist_ok=True)
            
            stored_path = os.path.join(files_dir, f"{file_hash}.{file_ext}")
            with open(stored_path, 'wb') as f:
                f.write(file_data)
            
            conn = self.get_connection()
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT INTO files (filename, file_type, file_size, file_hash, folder_id, tags, notes, preview_path)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (filename, file_ext, file_size, file_hash, folder_id, tags, notes, stored_path))
            
            file_id = cursor.lastrowid
            conn.commit()
            conn.close()
            
            return jsonify({"id": file_id, "message": "Upload success"})
        
        @self.app.route('/api/files/<int:file_id>', methods=['PUT'])
        def update_file(file_id):
            data = request.json
            
            conn = self.get_connection()
            cursor = conn.cursor()
            
            cursor.execute("UPDATE files SET tags = ?, notes = ?, folder_id = ? WHERE id = ?",
                          (data.get('tags', ''), data.get('notes', ''), data.get('folder_id'), file_id))
            
            conn.commit()
            conn.close()
            
            return jsonify({"message": "Update success"})
        
        @self.app.route('/api/files/<int:file_id>', methods=['DELETE'])
        def delete_file(file_id):
            conn = self.get_connection()
            cursor = conn.cursor()
            
            cursor.execute("SELECT file_hash, file_type FROM files WHERE id = ?", (file_id,))
            file = cursor.fetchone()
            
            if file:
                file_path = os.path.join("stored_files", f"{file['file_hash']}.{file['file_type']}")
                if os.path.exists(file_path):
                    os.remove(file_path)
            
            cursor.execute("DELETE FROM files WHERE id = ?", (file_id,))
            conn.commit()
            conn.close()
            
            return jsonify({"message": "Delete success"})
        
        @self.app.route('/api/files/<int:file_id>/download', methods=['GET'])
        def download_file(file_id):
            conn = self.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
            file = cursor.fetchone()
            conn.close()
            
            if file:
                file_path = os.path.join("stored_files", f"{file['file_hash']}.{file['file_type']}")
                if os.path.exists(file_path):
                    return send_file(file_path, as_attachment=True, download_name=file['filename'])
            
            return jsonify({"error": "File not found"}), 404
        
        @self.app.route('/api/folders', methods=['GET'])
        def get_folders():
            conn = self.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM folders ORDER BY name")
            folders = [dict(row) for row in cursor.fetchall()]
            conn.close()
            return jsonify({"folders": folders})
        
        @self.app.route('/api/folders', methods=['POST'])
        def create_folder():
            data = request.json
            
            conn = self.get_connection()
            cursor = conn.cursor()
            
            cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)",
                          (data['name'], data.get('parent_id')))
            
            folder_id = cursor.lastrowid
            conn.commit()
            conn.close()
            
            return jsonify({"id": folder_id, "message": "Create success"})
        
        @self.app.route('/api/folders/<int:folder_id>', methods=['DELETE'])
        def delete_folder(folder_id):
            conn = self.get_connection()
            cursor = conn.cursor()
            
            cursor.execute("UPDATE files SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
            cursor.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
            
            conn.commit()
            conn.close()
            
            return jsonify({"message": "Delete success"})
        
        @self.app.route('/api/stats', methods=['GET'])
        def get_stats():
            conn = self.get_connection()
            cursor = conn.cursor()
            
            cursor.execute("SELECT COUNT(*) as total_files FROM files")
            total_files = cursor.fetchone()['total_files']
            
            cursor.execute("SELECT SUM(file_size) as total_size FROM files")
            total_size = cursor.fetchone()['total_size'] or 0
            
            cursor.execute("SELECT COUNT(*) as total_folders FROM folders")
            total_folders = cursor.fetchone()['total_folders']
            
            conn.close()
            
            return jsonify({
                "total_files": total_files,
                "total_size": total_size,
                "total_folders": total_folders
            })
        
        @self.app.route('/api/health', methods=['GET'])
        def health_check():
            return jsonify({"status": "ok", "version": "1.0.0"})
    
    def run(self, host='0.0.0.0', port=5000):
        self.app.run(host=host, port=port, debug=False)

class FileManagerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("File Database Manager")
        self.root.geometry("1400x900")
        self.root.configure(bg='#1e1e2e')
        
        self.db_path = "file_database.db"
        self.files_dir = "stored_files"
        os.makedirs(self.files_dir, exist_ok=True)
        
        self.current_folder_id = None
        self.current_preview_image = None
        
        self.init_database()
        self.create_ui()
        self.load_folders()
        self.load_files()
        self.start_api_server()
    
    def start_api_server(self):
        if HAS_FLASK:
            def run_server():
                api = DatabaseAPI(self.db_path)
                api.run(port=5000)
            
            server_thread = threading.Thread(target=run_server, daemon=True)
            server_thread.start()
            print("API Server started: http://localhost:5000")
    
    def init_database(self):
        self.conn = sqlite3.connect(self.db_path)
        self.cursor = self.conn.cursor()
        
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_id INTEGER DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                original_path TEXT,
                file_type TEXT,
                file_size INTEGER,
                file_hash TEXT,
                folder_id INTEGER DEFAULT NULL,
                tags TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                preview_path TEXT
            )
        ''')
        
        self.cursor.execute("SELECT COUNT(*) FROM folders")
        if self.cursor.fetchone()[0] == 0:
            self.cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", ("All Files", None))
            self.cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", ("Images", None))
            self.cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", ("Documents", None))
            self.cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", ("Other", None))
        
        self.conn.commit()
    
    def create_ui(self):
        style = ttk.Style()
        style.theme_use('clam')
        
        style.configure('Treeview', 
                       background='#2d2d44',
                       foreground='white',
                       fieldbackground='#2d2d44',
                       rowheight=30)
        
        style.configure('Treeview.Heading',
                       background='#3d3d5c',
                       foreground='white',
                       font=('Arial', 10, 'bold'))
        
        style.configure('TButton',
                       background='#4d4d6a',
                       foreground='white',
                       font=('Arial', 10))
        
        style.configure('TLabel',
                       background='#1e1e2e',
                       foreground='white',
                       font=('Arial', 10))
        
        style.configure('TFrame',
                       background='#1e1e2e')
        
        style.configure('TLabelframe',
                       background='#2d2d44',
                       foreground='white')
        
        style.configure('TLabelframe.Label',
                       background='#2d2d44',
                       foreground='#00d4ff',
                       font=('Arial', 11, 'bold'))
        
        menubar = tk.Menu(self.root, bg='#2d2d44', fg='white')
        self.root.config(menu=menubar)
        
        file_menu = tk.Menu(menubar, tearoff=0, bg='#2d2d44', fg='white')
        menubar.add_cascade(label="File", menu=file_menu)
        file_menu.add_command(label="Import Files", command=self.import_files, accelerator="Ctrl+O")
        file_menu.add_command(label="Import Folder", command=self.import_folder)
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.root.quit)
        
        folder_menu = tk.Menu(menubar, tearoff=0, bg='#2d2d44', fg='white')
        menubar.add_cascade(label="Folder", menu=folder_menu)
        folder_menu.add_command(label="New Folder", command=self.create_folder, accelerator="Ctrl+N")
        folder_menu.add_command(label="Rename Folder", command=self.rename_folder)
        folder_menu.add_command(label="Delete Folder", command=self.delete_folder)
        
        edit_menu = tk.Menu(menubar, tearoff=0, bg='#2d2d44', fg='white')
        menubar.add_cascade(label="Edit", menu=edit_menu)
        edit_menu.add_command(label="Delete Selected", command=self.delete_selected, accelerator="Delete")
        edit_menu.add_command(label="Export Selected", command=self.export_selected)
        
        help_menu = tk.Menu(menubar, tearoff=0, bg='#2d2d44', fg='white')
        menubar.add_cascade(label="Help", menu=help_menu)
        help_menu.add_command(label="API Documentation", command=self.show_api_docs)
        
        self.root.bind('<Control-o>', lambda e: self.import_files())
        self.root.bind('<Control-n>', lambda e: self.create_folder())
        self.root.bind('<Delete>', lambda e: self.delete_selected())
        
        main_frame = ttk.Frame(self.root)
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        left_panel = tk.Frame(main_frame, bg='#2d2d44', width=250)
        left_panel.pack(side=tk.LEFT, fill=tk.Y, padx=(5,0), pady=5)
        left_panel.pack_propagate(False)
        
        folder_header = tk.Frame(left_panel, bg='#2d2d44')
        folder_header.pack(fill=tk.X, padx=10, pady=(10,5))
        
        tk.Label(folder_header, text="Folders", bg='#2d2d44', fg='#00d4ff', font=('Arial', 14, 'bold')).pack(side=tk.LEFT)
        
        add_btn = tk.Button(folder_header, text="+", bg='#e94560', fg='white', 
                           font=('Arial', 12, 'bold'), command=self.create_folder, bd=0, padx=10)
        add_btn.pack(side=tk.RIGHT)
        
        folder_tree_frame = tk.Frame(left_panel, bg='#2d2d44')
        folder_tree_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        self.folder_tree = ttk.Treeview(folder_tree_frame, show='tree', selectmode='browse')
        folder_scrollbar = ttk.Scrollbar(folder_tree_frame, orient=tk.VERTICAL, command=self.folder_tree.yview)
        self.folder_tree.configure(yscrollcommand=folder_scrollbar.set)
        
        self.folder_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        folder_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        self.folder_tree.bind('<<TreeviewSelect>>', self.on_folder_select)
        self.folder_tree.bind('<Button-3>', self.show_folder_context_menu)
        
        center_panel = tk.Frame(main_frame, bg='#1e1e2e')
        center_panel.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5, pady=5)
        
        search_frame = tk.Frame(center_panel, bg='#1e1e2e')
        search_frame.pack(fill=tk.X, pady=(0,10))
        
        tk.Label(search_frame, text="Search:", bg='#1e1e2e', fg='white', font=('Arial', 12)).pack(side=tk.LEFT, padx=(0,10))
        
        self.search_var = tk.StringVar()
        self.search_var.trace('w', lambda *args: self.search_files())
        search_entry = tk.Entry(search_frame, textvariable=self.search_var, width=30, 
                               bg='#2d2d44', fg='white', insertbackground='white', font=('Arial', 11))
        search_entry.pack(side=tk.LEFT, padx=(0,10))
        
        import_btn = tk.Button(search_frame, text="Import Files", bg='#4d4d6a', fg='white',
                              command=self.import_files, font=('Arial', 10), bd=0, padx=15, pady=5)
        import_btn.pack(side=tk.LEFT, padx=5)
        
        import_folder_btn = tk.Button(search_frame, text="Import Folder", bg='#4d4d6a', fg='white',
                                     command=self.import_folder, font=('Arial', 10), bd=0, padx=15, pady=5)
        import_folder_btn.pack(side=tk.LEFT, padx=5)
        
        self.status_label = tk.Label(search_frame, text="", bg='#1e1e2e', fg='#888888', font=('Arial', 10))
        self.status_label.pack(side=tk.RIGHT)
        
        drop_frame = tk.Frame(center_panel, bg='#2d2d44', relief=tk.GROOVE, bd=2)
        drop_frame.pack(fill=tk.X, pady=(0,10))
        
        tk.Label(drop_frame, text="Drop files here to import", bg='#2d2d44', fg='#666666', 
                font=('Arial', 13), pady=15).pack()
        
        list_frame = tk.Frame(center_panel, bg='#2d2d44')
        list_frame.pack(fill=tk.BOTH, expand=True)
        
        columns = ('id', 'filename', 'type', 'size', 'tags', 'created')
        self.file_tree = ttk.Treeview(list_frame, columns=columns, show='headings', selectmode='extended')
        
        self.file_tree.heading('id', text='ID')
        self.file_tree.heading('filename', text='Filename')
        self.file_tree.heading('type', text='Type')
        self.file_tree.heading('size', text='Size')
        self.file_tree.heading('tags', text='Tags')
        self.file_tree.heading('created', text='Created')
        
        self.file_tree.column('id', width=50)
        self.file_tree.column('filename', width=280)
        self.file_tree.column('type', width=80)
        self.file_tree.column('size', width=80)
        self.file_tree.column('tags', width=120)
        self.file_tree.column('created', width=140)
        
        file_scrollbar_y = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.file_tree.yview)
        self.file_tree.configure(yscrollcommand=file_scrollbar_y.set)
        self.file_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        file_scrollbar_y.pack(side=tk.RIGHT, fill=tk.Y)
        
        self.file_tree.bind('<<TreeviewSelect>>', self.on_file_select)
        self.file_tree.bind('<Double-1>', self.on_file_double_click)
        
        right_panel = tk.Frame(main_frame, bg='#2d2d44', width=350)
        right_panel.pack(side=tk.RIGHT, fill=tk.Y, padx=(0,5), pady=5)
        right_panel.pack_propagate(False)
        
        preview_label_frame = tk.LabelFrame(right_panel, text="Preview", bg='#2d2d44', fg='#00d4ff',
                                           font=('Arial', 11, 'bold'))
        preview_label_frame.pack(fill=tk.X, padx=10, pady=(10,5))
        
        self.preview_frame = tk.Frame(preview_label_frame, bg='#1e1e2e', height=200)
        self.preview_frame.pack(fill=tk.X, padx=5, pady=5)
        self.preview_frame.pack_propagate(False)
        
        self.preview_label = tk.Label(self.preview_frame, text="Select a file to preview", 
                                     bg='#1e1e2e', fg='#666666', font=('Arial', 11))
        self.preview_label.pack(expand=True)
        
        info_frame = tk.LabelFrame(right_panel, text="File Info", bg='#2d2d44', fg='#00d4ff',
                                  font=('Arial', 11, 'bold'))
        info_frame.pack(fill=tk.X, padx=10, pady=5)
        
        self.info_text = tk.Text(info_frame, height=5, wrap=tk.WORD, bg='#1e1e2e', fg='white',
                                insertbackground='white', font=('Arial', 10))
        self.info_text.pack(fill=tk.X, padx=5, pady=5)
        
        edit_frame = tk.LabelFrame(right_panel, text="Edit Info", bg='#2d2d44', fg='#00d4ff',
                                  font=('Arial', 11, 'bold'))
        edit_frame.pack(fill=tk.X, padx=10, pady=5)
        
        tk.Label(edit_frame, text="Tags:", bg='#2d2d44', fg='white', font=('Arial', 10)).pack(anchor=tk.W, padx=5)
        self.tags_var = tk.StringVar()
        tk.Entry(edit_frame, textvariable=self.tags_var, bg='#1e1e2e', fg='white', 
                insertbackground='white', font=('Arial', 10)).pack(fill=tk.X, padx=5, pady=(0,5))
        
        tk.Label(edit_frame, text="Notes:", bg='#2d2d44', fg='white', font=('Arial', 10)).pack(anchor=tk.W, padx=5)
        self.notes_text = tk.Text(edit_frame, height=2, wrap=tk.WORD, bg='#1e1e2e', fg='white',
                                 insertbackground='white', font=('Arial', 10))
        self.notes_text.pack(fill=tk.X, padx=5, pady=(0,5))
        
        btn_frame = tk.Frame(edit_frame, bg='#2d2d44')
        btn_frame.pack(fill=tk.X, padx=5, pady=5)
        
        tk.Button(btn_frame, text="Save", bg='#4CAF50', fg='white', command=self.save_file_info,
                 font=('Arial', 10), bd=0, padx=15, pady=5).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        tk.Button(btn_frame, text="Delete", bg='#e94560', fg='white', command=self.delete_selected,
                 font=('Arial', 10), bd=0, padx=15, pady=5).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        tk.Button(btn_frame, text="Export", bg='#4d4d6a', fg='white', command=self.export_selected,
                 font=('Arial', 10), bd=0, padx=15, pady=5).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        
        self.current_file_id = None
    
    def show_api_docs(self):
        docs_text = """File Database Manager API Documentation

Base URL: http://localhost:5000

File Endpoints:
GET    /api/files          - Get file list
GET    /api/files/{id}     - Get file details
POST   /api/files          - Upload file
PUT    /api/files/{id}     - Update file info
DELETE /api/files/{id}     - Delete file
GET    /api/files/{id}/download  - Download file

Folder Endpoints:
GET    /api/folders        - Get folder list
POST   /api/folders        - Create folder
DELETE /api/folders/{id}   - Delete folder

Stats:
GET    /api/stats          - Get statistics
GET    /api/health         - Health check

Query Parameters:
- folder_id: Filter by folder
- search: Search keyword
- limit: Result limit
- offset: Pagination offset

Examples:
# Get all files
curl http://localhost:5000/api/files

# Search files
curl "http://localhost:5000/api/files?search=test"

# Upload file
curl -X POST -F "file=@test.txt" http://localhost:5000/api/files

# Create folder
curl -X POST -H "Content-Type: application/json" \\
     -d '{"name":"New Folder"}' \\
     http://localhost:5000/api/folders"""
        
        docs_window = tk.Toplevel(self.root)
        docs_window.title("API Documentation")
        docs_window.geometry("600x700")
        docs_window.configure(bg='#1e1e2e')
        
        text_widget = tk.Text(docs_window, wrap=tk.WORD, font=('Consolas', 11),
                             bg='#2d2d44', fg='white', insertbackground='white')
        scrollbar = ttk.Scrollbar(docs_window, orient=tk.VERTICAL, command=text_widget.yview)
        text_widget.configure(yscrollcommand=scrollbar.set)
        
        text_widget.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        text_widget.insert(1.0, docs_text)
        text_widget.config(state=tk.DISABLED)
    
    def load_folders(self):
        for item in self.folder_tree.get_children():
            self.folder_tree.delete(item)
        
        self.cursor.execute("SELECT id, name, parent_id FROM folders WHERE parent_id IS NULL ORDER BY name")
        folders = self.cursor.fetchall()
        
        self.folder_tree.insert('', tk.END, text='All Files', values=(0,), open=True)
        
        for folder_id, name, parent_id in folders:
            if name == "All Files":
                continue
            self.folder_tree.insert('', tk.END, text=name, values=(folder_id,))
    
    def on_folder_select(self, event):
        selection = self.folder_tree.selection()
        if not selection:
            return
        
        item = self.folder_tree.item(selection[0])
        folder_id = item['values'][0]
        self.current_folder_id = folder_id if folder_id > 0 else None
        
        self.load_files()
    
    def show_folder_context_menu(self, event):
        menu = tk.Menu(self.root, tearoff=0, bg='#2d2d44', fg='white')
        menu.add_command(label="New Folder", command=self.create_folder)
        menu.add_command(label="Rename", command=self.rename_folder)
        menu.add_command(label="Delete", command=self.delete_folder)
        menu.post(event.x_root, event.y_root)
    
    def create_folder(self):
        dialog = tk.Toplevel(self.root)
        dialog.title("New Folder")
        dialog.geometry("300x100")
        dialog.configure(bg='#1e1e2e')
        dialog.transient(self.root)
        dialog.grab_set()
        
        tk.Label(dialog, text="Folder name:", bg='#1e1e2e', fg='white').pack(padx=10, pady=5, anchor=tk.W)
        name_var = tk.StringVar()
        name_entry = tk.Entry(dialog, textvariable=name_var, width=35, bg='#2d2d44', fg='white', insertbackground='white')
        name_entry.pack(padx=10, pady=5)
        name_entry.focus_set()
        
        def create():
            name = name_var.get().strip()
            if not name:
                messagebox.showwarning("Warning", "Please enter folder name")
                return
            
            self.cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", (name, None))
            self.conn.commit()
            
            self.load_folders()
            self.load_files()
            dialog.destroy()
            messagebox.showinfo("Success", f"Folder '{name}' created")
        
        tk.Button(dialog, text="Create", bg='#4CAF50', fg='white', command=create, bd=0, padx=20).pack(pady=10)
        name_entry.bind('<Return>', lambda e: create())
    
    def rename_folder(self):
        selection = self.folder_tree.selection()
        if not selection:
            messagebox.showwarning("Warning", "Please select a folder to rename")
            return
        
        item = self.folder_tree.item(selection[0])
        folder_id = item['values'][0]
        
        if folder_id == 0:
            messagebox.showwarning("Warning", "Cannot rename 'All Files' folder")
            return
        
        old_name = item['text']
        
        dialog = tk.Toplevel(self.root)
        dialog.title("Rename Folder")
        dialog.geometry("300x100")
        dialog.configure(bg='#1e1e2e')
        dialog.transient(self.root)
        dialog.grab_set()
        
        tk.Label(dialog, text="New name:", bg='#1e1e2e', fg='white').pack(padx=10, pady=5, anchor=tk.W)
        name_var = tk.StringVar(value=old_name)
        name_entry = tk.Entry(dialog, textvariable=name_var, width=35, bg='#2d2d44', fg='white', insertbackground='white')
        name_entry.pack(padx=10, pady=5)
        name_entry.select_range(0, tk.END)
        name_entry.focus_set()
        
        def rename():
            new_name = name_var.get().strip()
            if not new_name:
                messagebox.showwarning("Warning", "Please enter folder name")
                return
            
            self.cursor.execute("UPDATE folders SET name = ? WHERE id = ?", (new_name, folder_id))
            self.conn.commit()
            
            self.load_folders()
            self.load_files()
            dialog.destroy()
        
        tk.Button(dialog, text="Rename", bg='#4CAF50', fg='white', command=rename, bd=0, padx=20).pack(pady=10)
        name_entry.bind('<Return>', lambda e: rename())
    
    def delete_folder(self):
        selection = self.folder_tree.selection()
        if not selection:
            messagebox.showwarning("Warning", "Please select a folder to delete")
            return
        
        item = self.folder_tree.item(selection[0])
        folder_id = item['values'][0]
        folder_name = item['text']
        
        if folder_id == 0:
            messagebox.showwarning("Warning", "Cannot delete 'All Files' folder")
            return
        
        if not messagebox.askyesno("Confirm Delete", f"Delete folder '{folder_name}'?\nFiles will be moved to uncategorized."):
            return
        
        self.cursor.execute("UPDATE files SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
        self.cursor.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        self.conn.commit()
        
        self.load_folders()
        self.load_files()
        messagebox.showinfo("Success", f"Folder '{folder_name}' deleted")
    
    def load_files(self):
        for item in self.file_tree.get_children():
            self.file_tree.delete(item)
        
        if self.current_folder_id is None:
            self.cursor.execute("SELECT id, filename, file_type, file_size, tags, created_at FROM files ORDER BY created_at DESC")
        else:
            self.cursor.execute("SELECT id, filename, file_type, file_size, tags, created_at FROM files WHERE folder_id = ? ORDER BY created_at DESC", (self.current_folder_id,))
        
        files = self.cursor.fetchall()
        
        for file in files:
            file_id, filename, file_type, file_size, tags, created_at = file
            size_str = self.format_size(file_size) if file_size else "Unknown"
            type_str = file_type.upper() if file_type else "Unknown"
            tags_str = tags if tags else ""
            created_str = created_at[:19] if created_at else ""
            
            icon = self.get_file_icon(file_type)
            self.file_tree.insert('', tk.END, values=(file_id, f"{icon} {filename}", type_str, size_str, tags_str, created_str))
        
        total = len(files)
        total_size = sum(f[3] or 0 for f in files)
        self.status_label.config(text=f"{total} files, {self.format_size(total_size)}")
    
    def get_file_icon(self, file_type):
        icons = {
            'png': '🖼', 'jpg': '🖼', 'jpeg': '🖼', 'gif': '🖼', 'bmp': '🖼', 'webp': '🖼',
            'txt': '📄', 'md': '📄', 'log': '📄',
            'py': '💻', 'js': '💻', 'ts': '💻', 'java': '💻', 'c': '💻', 'cpp': '💻', 'cs': '💻',
            'html': '🌐', 'css': '🌐',
            'json': '📋', 'xml': '📋', 'yaml': '📋',
            'pdf': '📕', 'doc': '📘', 'docx': '📘',
            'xls': '📗', 'xlsx': '📗',
            'zip': '📦', 'rar': '📦', '7z': '📦',
            'mp3': '🎵', 'wav': '🎵',
            'mp4': '🎬', 'avi': '🎬',
        }
        return icons.get(file_type, '📄')
    
    def format_size(self, size):
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024:
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"
    
    def import_files(self):
        filetypes = [
            ("All files", "*.*"),
            ("Images", "*.png *.jpg *.jpeg *.gif *.bmp *.ico *.webp"),
            ("Text files", "*.txt *.md *.py *.js *.html *.css *.json *.xml"),
            ("Documents", "*.pdf *.doc *.docx *.xls *.xlsx"),
        ]
        
        files = filedialog.askopenfilenames(title="Select files", filetypes=filetypes)
        
        if not files:
            return
        
        count = 0
        for file_path in files:
            if self.add_file_to_db(file_path):
                count += 1
        
        self.load_files()
        messagebox.showinfo("Import Complete", f"Successfully imported {count} files")
    
    def import_folder(self):
        folder_path = filedialog.askdirectory(title="Select folder")
        if not folder_path:
            return
        
        count = 0
        for root_dir, dirs, files in os.walk(folder_path):
            for file in files:
                file_path = os.path.join(root_dir, file)
                if self.add_file_to_db(file_path):
                    count += 1
        
        self.load_files()
        messagebox.showinfo("Import Complete", f"Successfully imported {count} files")
    
    def add_file_to_db(self, file_path):
        if not os.path.exists(file_path):
            return False
        
        filename = os.path.basename(file_path)
        file_ext = os.path.splitext(filename)[1].lower().replace('.', '')
        file_size = os.path.getsize(file_path)
        
        with open(file_path, 'rb') as f:
            file_hash = hashlib.md5(f.read()).hexdigest()
        
        self.cursor.execute("SELECT id FROM files WHERE file_hash = ?", (file_hash,))
        if self.cursor.fetchone():
            return False
        
        stored_filename = f"{file_hash}.{file_ext}"
        stored_path = os.path.join(self.files_dir, stored_filename)
        shutil.copy2(file_path, stored_path)
        
        folder_id = self.current_folder_id if self.current_folder_id and self.current_folder_id > 0 else None
        
        self.cursor.execute('''
            INSERT INTO files (filename, original_path, file_type, file_size, file_hash, folder_id, preview_path)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (filename, file_path, file_ext, file_size, file_hash, folder_id, stored_path))
        self.conn.commit()
        
        return True
    
    def search_files(self):
        keyword = self.search_var.get().strip()
        
        for item in self.file_tree.get_children():
            self.file_tree.delete(item)
        
        if keyword:
            self.cursor.execute('''
                SELECT id, filename, file_type, file_size, tags, created_at 
                FROM files 
                WHERE filename LIKE ? OR tags LIKE ? OR notes LIKE ?
                ORDER BY created_at DESC
            ''', (f'%{keyword}%', f'%{keyword}%', f'%{keyword}%'))
        else:
            self.load_files()
            return
        
        files = self.cursor.fetchall()
        
        for file in files:
            file_id, filename, file_type, file_size, tags, created_at = file
            size_str = self.format_size(file_size) if file_size else "Unknown"
            type_str = file_type.upper() if file_type else "Unknown"
            tags_str = tags if tags else ""
            created_str = created_at[:19] if created_at else ""
            
            icon = self.get_file_icon(file_type)
            self.file_tree.insert('', tk.END, values=(file_id, f"{icon} {filename}", type_str, size_str, tags_str, created_str))
        
        self.status_label.config(text=f"Search: {len(files)} files")
    
    def on_file_select(self, event):
        selection = self.file_tree.selection()
        if not selection:
            return
        
        item = self.file_tree.item(selection[0])
        file_id = item['values'][0]
        self.current_file_id = file_id
        
        self.cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
        file = self.cursor.fetchone()
        
        if file:
            self.show_file_info(file)
            self.load_preview(file)
    
    def show_file_info(self, file):
        file_id, filename, original_path, file_type, file_size, file_hash, folder_id, tags, notes, created_at, preview_path = file
        
        info = f"Filename: {filename}\n"
        info += f"Type: {file_type.upper() if file_type else 'Unknown'}\n"
        info += f"Size: {self.format_size(file_size) if file_size else 'Unknown'}\n"
        info += f"Tags: {tags if tags else 'None'}\n"
        info += f"Created: {created_at}"
        
        self.info_text.delete(1.0, tk.END)
        self.info_text.insert(1.0, info)
        
        self.tags_var.set(tags if tags else "")
        self.notes_text.delete(1.0, tk.END)
        self.notes_text.insert(1.0, notes if notes else "")
    
    def load_preview(self, file):
        file_id, filename, original_path, file_type, file_size, file_hash, folder_id, tags, notes, created_at, preview_path = file
        
        self.preview_label.config(image='')
        self.current_preview_image = None
        
        if file_type in ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp']:
            try:
                img = Image.open(preview_path)
                img.thumbnail((320, 180))
                self.current_preview_image = ImageTk.PhotoImage(img)
                self.preview_label.config(image=self.current_preview_image, text='')
            except Exception as e:
                self.preview_label.config(text=f"Preview error\n{str(e)}")
        else:
            self.preview_label.config(text=f"📁 {file_type.upper()}\nNo preview available")
    
    def save_file_info(self):
        if not self.current_file_id:
            messagebox.showwarning("Warning", "Please select a file first")
            return
        
        tags = self.tags_var.get().strip()
        notes = self.notes_text.get(1.0, tk.END).strip()
        
        self.cursor.execute("UPDATE files SET tags = ?, notes = ? WHERE id = ?", 
                           (tags, notes, self.current_file_id))
        self.conn.commit()
        
        self.load_files()
        messagebox.showinfo("Success", "File info saved")
    
    def delete_selected(self):
        selection = self.file_tree.selection()
        if not selection:
            messagebox.showwarning("Warning", "Please select files to delete")
            return
        
        if not messagebox.askyesno("Confirm Delete", f"Delete {len(selection)} selected files?"):
            return
        
        for item in selection:
            file_id = self.file_tree.item(item)['values'][0]
            
            self.cursor.execute("SELECT file_hash, file_type FROM files WHERE id = ?", (file_id,))
            file = self.cursor.fetchone()
            
            if file:
                file_path = os.path.join(self.files_dir, f"{file[0]}.{file[1]}")
                if os.path.exists(file_path):
                    os.remove(file_path)
            
            self.cursor.execute("DELETE FROM files WHERE id = ?", (file_id,))
        
        self.conn.commit()
        self.load_files()
        messagebox.showinfo("Success", f"Deleted {len(selection)} files")
    
    def export_selected(self):
        selection = self.file_tree.selection()
        if not selection:
            messagebox.showwarning("Warning", "Please select files to export")
            return
        
        export_dir = filedialog.askdirectory(title="Select export directory")
        if not export_dir:
            return
        
        count = 0
        for item in selection:
            file_id = self.file_tree.item(item)['values'][0]
            
            self.cursor.execute("SELECT filename, file_hash, file_type FROM files WHERE id = ?", (file_id,))
            file = self.cursor.fetchone()
            
            if file:
                filename, file_hash, file_type = file
                src_path = os.path.join(self.files_dir, f"{file_hash}.{file_type}")
                
                real_filename = filename
                if not filename.endswith(f'.{file_type}'):
                    real_filename = f"{filename}.{file_type}"
                
                dst_path = os.path.join(export_dir, real_filename)
                
                counter = 1
                while os.path.exists(dst_path):
                    name, ext = os.path.splitext(real_filename)
                    dst_path = os.path.join(export_dir, f"{name}_{counter}{ext}")
                    counter += 1
                
                if os.path.exists(src_path):
                    shutil.copy2(src_path, dst_path)
                    count += 1
        
        messagebox.showinfo("Export Complete", f"Exported {count} files to:\n{export_dir}")
    
    def on_file_double_click(self, event):
        selection = self.file_tree.selection()
        if not selection:
            return
        
        file_id = self.file_tree.item(selection[0])['values'][0]
        self.cursor.execute("SELECT original_path FROM files WHERE id = ?", (file_id,))
        result = self.cursor.fetchone()
        
        if result and result[0] and os.path.exists(result[0]):
            os.startfile(result[0])
        else:
            messagebox.showinfo("Info", "Original file not found or has been moved")
    
    def __del__(self):
        if hasattr(self, 'conn'):
            self.conn.close()

def main():
    root = tk.Tk()
    app = FileManagerApp(root)
    root.mainloop()

if __name__ == "__main__":
    main()
