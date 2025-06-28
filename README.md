# a1noter - MIDI 转 Bambu Lab 3轨格式转换工具

## 简介

`a1noter` 是一个将标准 MIDI 文件转换为 Bambu Lab 3音轨兼容格式的命令行工具。  
它可以将任意多轨MIDI文件智能分配到3个轨道，适用于Bambu Lab等只支持3音轨的设备。

## 特性

- 支持任意标准MIDI文件（.mid/.midi）
- 智能音符分配算法，尽量保持音乐完整性
- 输出标准MIDI文件，兼容Bambu Lab等设备
- 命令行参数友好，支持详细日志

## 安装

需要 Node.js 16+ 环境。

```bash
npm install
```

或仅需安装依赖：

```bash
npm install @tonejs/midi commander
```

## 使用方法

```bash
node main.js --input <输入MIDI文件> --output <输出MIDI文件> [--verbose]
```

**参数说明：**

- `-i, --input`   输入MIDI文件路径（必须，.mid/.midi）
- `-o, --output`  输出MIDI文件路径（必须）
- `-v, --verbose` 显示详细处理信息（可选）

**示例：**

```bash
node main.js --input test.mid --output bambu3.mid
```

## 算法说明

- 所有音符按时间排序，优先分配到同音轨，不重叠时同轨，有重叠时分轨。
- 超过3轨重叠时，自动分配到负载最轻的轨道，尽量减少音符丢失。

## 依赖

- [@tonejs/midi](https://github.com/Tonejs/Midi)
- [commander](https://github.com/tj/commander.js)

## 许可证

MIT License

---
作者：mrjiang32pines(awa)
