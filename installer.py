import os
import sys
import sqlite3
import hashlib
import shutil
import winreg
from datetime import datetime
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from PIL import Image, ImageTk
import io
import subprocess

class InstallerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("文件数据库管理器 - 安装程序")
        self.root.geometry("500x400")
        self.root.resizable(False, False)
        
        self.install_dir = os.path.join(os.environ.get('PROGRAMFILES', 'C:\\Program Files'), "文件数据库管理器")
        self.create_ui()
    
    def create_ui(self):
        main_frame = ttk.Frame(self.root, padding="20")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        title_label = ttk.Label(main_frame, text="文件数据库管理器 安装向导", font=('Arial', 18, 'bold'))
        title_label.pack(pady=(0, 20))
        
        ttk.Separator(main_frame, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=10)
        
        info_frame = ttk.Frame(main_frame)
        info_frame.pack(fill=tk.X, pady=10)
        
        ttk.Label(info_frame, text="欢迎使用文件数据库管理器安装程序", font=('Arial', 12)).pack(anchor=tk.W)
        ttk.Label(info_frame, text="本程序将安装文件数据库管理器到您的计算机", font=('Arial', 10)).pack(anchor=tk.W, pady=(5, 0))
        
        dir_frame = ttk.LabelFrame(main_frame, text="安装位置", padding="10")
        dir_frame.pack(fill=tk.X, pady=10)
        
        self.dir_var = tk.StringVar(value=self.install_dir)
        ttk.Entry(dir_frame, textvariable=self.dir_var, width=50).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(dir_frame, text="浏览...", command=self.browse_dir).pack(side=tk.RIGHT, padx=(10, 0))
        
        self.create_shortcut_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(main_frame, text="创建桌面快捷方式", variable=self.create_shortcut_var).pack(anchor=tk.W, pady=5)
        
        self.create_startmenu_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(main_frame, text="创建开始菜单项", variable=self.create_startmenu_var).pack(anchor=tk.W, pady=5)
        
        ttk.Separator(main_frame, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=10)
        
        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(fill=tk.X)
        
        ttk.Button(btn_frame, text="取消", command=self.root.destroy).pack(side=tk.RIGHT)
        ttk.Button(btn_frame, text="安装", command=self.install).pack(side=tk.RIGHT, padx=10)
    
    def browse_dir(self):
        dir_path = filedialog.askdirectory(title="选择安装目录")
        if dir_path:
            self.dir_var.set(os.path.join(dir_path, "文件数据库管理器"))
    
    def install(self):
        install_path = self.dir_var.get()
        
        try:
            os.makedirs(install_path, exist_ok=True)
            
            src_exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist", "文件数据库管理器.exe")
            if not os.path.exists(src_exe):
                src_exe = "文件数据库管理器.exe"
            
            if os.path.exists(src_exe):
                shutil.copy2(src_exe, install_path)
            else:
                messagebox.showerror("错误", "找不到安装文件")
                return
            
            if self.create_shortcut_var.get():
                self.create_desktop_shortcut(install_path)
            
            if self.create_startmenu_var.get():
                self.create_start_menu_shortcut(install_path)
            
            self.add_uninstall_info(install_path)
            
            messagebox.showinfo("安装完成", f"文件数据库管理器已成功安装到:\n{install_path}")
            
            if messagebox.askyesno("安装完成", "是否立即启动程序？"):
                subprocess.Popen([os.path.join(install_path, "文件数据库管理器.exe")])
            
            self.root.destroy()
            
        except Exception as e:
            messagebox.showerror("安装失败", f"安装过程中出现错误:\n{str(e)}")
    
    def create_desktop_shortcut(self, install_path):
        try:
            desktop_path = os.path.join(os.path.expanduser("~"), "Desktop")
            shortcut_path = os.path.join(desktop_path, "文件数据库管理器.lnk")
            
            exe_path = os.path.join(install_path, "文件数据库管理器.exe")
            
            ps_command = f'''
            $WshShell = New-Object -ComObject WScript.Shell
            $Shortcut = $WshShell.CreateShortcut("{shortcut_path}")
            $Shortcut.TargetPath = "{exe_path}"
            $Shortcut.WorkingDirectory = "{install_path}"
            $Shortcut.Save()
            '''
            
            subprocess.run(["powershell", "-Command", ps_command], capture_output=True)
        except Exception as e:
            print(f"创建桌面快捷方式失败: {e}")
    
    def create_start_menu_shortcut(self, install_path):
        try:
            start_menu_path = os.path.join(os.environ.get('APPDATA', ''), "Microsoft", "Windows", "Start Menu", "Programs", "文件数据库管理器")
            os.makedirs(start_menu_path, exist_ok=True)
            
            shortcut_path = os.path.join(start_menu_path, "文件数据库管理器.lnk")
            exe_path = os.path.join(install_path, "文件数据库管理器.exe")
            
            ps_command = f'''
            $WshShell = New-Object -ComObject WScript.Shell
            $Shortcut = $WshShell.CreateShortcut("{shortcut_path}")
            $Shortcut.TargetPath = "{exe_path}"
            $Shortcut.WorkingDirectory = "{install_path}"
            $Shortcut.Save()
            '''
            
            subprocess.run(["powershell", "-Command", ps_command], capture_output=True)
        except Exception as e:
            print(f"创建开始菜单快捷方式失败: {e}")
    
    def add_uninstall_info(self, install_path):
        try:
            uninstall_key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall\文件数据库管理器")
            winreg.SetValueEx(uninstall_key, "DisplayName", 0, winreg.REG_SZ, "文件数据库管理器")
            winreg.SetValueEx(uninstall_key, "UninstallString", 0, winreg.REG_SZ, f'"{os.path.join(install_path, "uninstall.exe")}"')
            winreg.SetValueEx(uninstall_key, "InstallLocation", 0, winreg.REG_SZ, install_path)
            winreg.SetValueEx(uninstall_key, "DisplayVersion", 0, winreg.REG_SZ, "1.0")
            winreg.SetValueEx(uninstall_key, "Publisher", 0, winreg.REG_SZ, "EZdrang")
            winreg.CloseKey(uninstall_key)
            
            uninstall_script = f'''
import os
import shutil
import winreg

install_path = r"{install_path}"
shortcut_desktop = os.path.join(os.path.expanduser("~"), "Desktop", "文件数据库管理器.lnk")
shortcut_startmenu = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "文件数据库管理器", "文件数据库管理器.lnk")

if os.path.exists(shortcut_desktop):
    os.remove(shortcut_desktop)
if os.path.exists(shortcut_startmenu):
    os.remove(shortcut_startmenu)
if os.path.exists(os.path.dirname(shortcut_startmenu)):
    os.rmdir(os.path.dirname(shortcut_startmenu))

try:
    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, r"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\文件数据库管理器")
except:
    pass

if os.path.exists(install_path):
    shutil.rmtree(install_path)

print("卸载完成")
input("按回车键退出...")
'''
            
            uninstall_path = os.path.join(install_path, "uninstall.exe")
            with open(os.path.join(install_path, "uninstall.py"), "w", encoding="utf-8") as f:
                f.write(uninstall_script)
            
            subprocess.run(["python", "-m", "PyInstaller", "--onefile", "--windowed", "--name", "uninstall", os.path.join(install_path, "uninstall.py")], 
                          cwd=install_path, capture_output=True)
            
            if os.path.exists(os.path.join(install_path, "dist", "uninstall.exe")):
                shutil.move(os.path.join(install_path, "dist", "uninstall.exe"), uninstall_path)
                shutil.rmtree(os.path.join(install_path, "dist"), ignore_errors=True)
                shutil.rmtree(os.path.join(install_path, "build"), ignore_errors=True)
                os.remove(os.path.join(install_path, "uninstall.py"))
                if os.path.exists(os.path.join(install_path, "uninstall.spec")):
                    os.remove(os.path.join(install_path, "uninstall.spec"))
            
        except Exception as e:
            print(f"创建卸载程序失败: {e}")

def main():
    root = tk.Tk()
    app = InstallerApp(root)
    root.mainloop()

if __name__ == "__main__":
    main()
