import os
import sqlite3
import hashlib
import shutil
import json
from datetime import datetime
from pathlib import Path
from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename
import webbrowser
import threading

app = Flask(__name__, static_folder='web')
CORS(app)

DB_PATH = "file_database.db"
FILES_DIR = "stored_files"
os.makedirs(FILES_DIR, exist_ok=True)

def init_database():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            original_path TEXT,
            file_type TEXT,
            file_size INTEGER,
            file_hash TEXT,
            folder_id INTEGER DEFAULT NULL,
            tags TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            preview_path TEXT
        )
    ''')
    
    cursor.execute("SELECT COUNT(*) FROM folders")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", ("All Files", None))
        cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", ("Images", None))
        cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", ("Documents", None))
        cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)", ("Other", None))
    
    conn.commit()
    conn.close()

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

@app.route('/')
def index():
    return send_from_directory('web', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('web', path)

@app.route('/api/files', methods=['GET'])
def get_files():
    conn = get_db()
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

@app.route('/api/files/<int:file_id>', methods=['GET'])
def get_file(file_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
    file = cursor.fetchone()
    conn.close()
    
    if file:
        return jsonify(dict(file))
    return jsonify({"error": "File not found"}), 404

@app.route('/api/files', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({"error": "No file"}), 400
    
    file = request.files['file']
    folder_id = request.form.get('folder_id')
    tags = request.form.get('tags', '')
    notes = request.form.get('notes', '')
    
    filename = secure_filename(file.filename)
    file_ext = os.path.splitext(filename)[1].lower().replace('.', '')
    
    file_data = file.read()
    file_hash = hashlib.md5(file_data).hexdigest()
    file_size = len(file_data)
    
    stored_path = os.path.join(FILES_DIR, f"{file_hash}.{file_ext}")
    with open(stored_path, 'wb') as f:
        f.write(file_data)
    
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute('''
        INSERT INTO files (filename, file_type, file_size, file_hash, folder_id, tags, notes, preview_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (filename, file_ext, file_size, file_hash, folder_id, tags, notes, stored_path))
    
    file_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    return jsonify({"id": file_id, "message": "Upload success"})

@app.route('/api/files/<int:file_id>', methods=['PUT'])
def update_file(file_id):
    data = request.json
    
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("UPDATE files SET tags = ?, notes = ?, folder_id = ? WHERE id = ?",
                  (data.get('tags', ''), data.get('notes', ''), data.get('folder_id'), file_id))
    
    conn.commit()
    conn.close()
    
    return jsonify({"message": "Update success"})

@app.route('/api/files/<int:file_id>', methods=['DELETE'])
def delete_file(file_id):
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT file_hash, file_type FROM files WHERE id = ?", (file_id,))
    file = cursor.fetchone()
    
    if file:
        file_path = os.path.join(FILES_DIR, f"{file['file_hash']}.{file['file_type']}")
        if os.path.exists(file_path):
            os.remove(file_path)
    
    cursor.execute("DELETE FROM files WHERE id = ?", (file_id,))
    conn.commit()
    conn.close()
    
    return jsonify({"message": "Delete success"})

@app.route('/api/files/<int:file_id>/download', methods=['GET'])
def download_file(file_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
    file = cursor.fetchone()
    conn.close()
    
    if file and os.path.exists(file['preview_path']):
        return send_file(file['preview_path'], as_attachment=True, download_name=file['filename'])
    
    return jsonify({"error": "File not found"}), 404

@app.route('/api/files/<int:file_id>/preview', methods=['GET'])
def preview_file(file_id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
    file = cursor.fetchone()
    conn.close()
    
    if file:
        if file['file_type'] in ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']:
            return send_file(file['preview_path'])
        elif file['file_type'] in ['txt', 'md', 'py', 'js', 'json', 'xml', 'html', 'css']:
            with open(file['preview_path'], 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read(10000)
            return jsonify({"content": content, "type": "text"})
    
    return jsonify({"error": "Cannot preview"}), 404

@app.route('/api/folders', methods=['GET'])
def get_folders():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM folders ORDER BY name")
    folders = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify({"folders": folders})

@app.route('/api/folders', methods=['POST'])
def create_folder():
    data = request.json
    
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("INSERT INTO folders (name, parent_id) VALUES (?, ?)",
                  (data['name'], data.get('parent_id')))
    
    folder_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    return jsonify({"id": folder_id, "message": "Create success"})

@app.route('/api/folders/<int:folder_id>', methods=['PUT'])
def update_folder(folder_id):
    data = request.json
    
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE folders SET name = ? WHERE id = ?", (data['name'], folder_id))
    conn.commit()
    conn.close()
    
    return jsonify({"message": "Update success"})

@app.route('/api/folders/<int:folder_id>', methods=['DELETE'])
def delete_folder(folder_id):
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("UPDATE files SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
    cursor.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    
    conn.commit()
    conn.close()
    
    return jsonify({"message": "Delete success"})

@app.route('/api/stats', methods=['GET'])
def get_stats():
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT COUNT(*) as total_files FROM files")
    total_files = cursor.fetchone()['total_files']
    
    cursor.execute("SELECT SUM(file_size) as total_size FROM files")
    total_size = cursor.fetchone()['total_size'] or 0
    
    cursor.execute("SELECT COUNT(*) as total_folders FROM folders")
    total_folders = cursor.fetchone()['total_folders']
    
    conn.close()
    
    return jsonify({
        "totalFiles": total_files,
        "totalSize": total_size,
        "totalFolders": total_folders
    })

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({"status": "ok", "version": "1.0.0"})

if __name__ == '__main__':
    init_database()
    webbrowser.open('http://localhost:5000')
    app.run(host='0.0.0.0', port=5000, debug=False)
