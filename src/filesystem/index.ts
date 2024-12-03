#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]");
  process.exit(1);
}

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p).toLowerCase();
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = args.map(dir => 
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate that all directories exist and are accessible
await Promise.all(args.map(async (dir) => {
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) {
      console.error(`Error: ${dir} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing directory ${dir}:`, error);
    process.exit(1);
  }
}));

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);
    
  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  startLine: z.number().int().min(1).optional(),  
  contextLines: z.number().int().min(0).default(3),
  oldText: z.string(),
  newText: z.string(),
  verifyState: z.boolean().default(true),
  readBeforeEdit: z.boolean().default(false),
  findAnchor: z.string().optional(),  
  anchorOffset: z.number().int().default(0), 
  beforeContext: z.string().optional(), 
  afterContext: z.string().optional(),  
  contextRadius: z.number().int().min(0).default(3), 
  insertMode: z.enum(['replace', 'before', 'after']).default('replace'), 
  dryRun: z.boolean().default(false), 
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

// Server setup
const server = new Server(
  {
    name: "secure-filesystem-server",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool implementations
async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

async function searchFiles(
  rootPath: string,
  pattern: string,
): Promise<string[]> {
  const results: string[] = [];

  async function search(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      
      try {
        // Validate each path before processing
        await validatePath(fullPath);

        if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
          results.push(fullPath);
        }

        if (entry.isDirectory()) {
          await search(fullPath);
        }
      } catch (error) {
        // Skip invalid paths during search
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}

// Content normalization utilities
// These functions handle:
// - Line ending normalization (CRLF vs LF)
// - Indentation preservation and normalization
// - Git's core.autocrlf setting
// - Mixed line endings
// This makes the edit functionality reliable across different environments and formatting styles

function normalizeForComparison(content: string): string {
  // First normalize line endings
  let normalized = content.replace(/\r\n/g, '\n');
  // Remove leading/trailing whitespace from each line while preserving empty lines
  normalized = normalized.split('\n')
    .map(line => line.trim())
    .join('\n');
  return normalized;
}

function preserveIndentation(newContent: string, originalContent: string): string {
  const originalLines = originalContent.split(/\r?\n/);
  const indentMatch = originalLines.find(line => line.trim())?.match(/^\s*/);
  const baseIndent = indentMatch ? indentMatch[0] : '';
  
  return newContent.split(/\r?\n/)
    .map(line => line.trim() ? baseIndent + line : line)
    .join(originalContent.includes('\r\n') ? '\r\n' : '\n');
}

function detectLineEnding(content: string): string {
  // Check if the content contains CRLF
  if (content.includes('\r\n')) {
    return '\r\n';
  }
  // Default to LF
  return '\n';
}

function normalizeLineEndings(content: string): string {
  // Convert all line endings to LF for internal processing
  return content.replace(/\r\n/g, '\n');
}

function preserveLineEndings(newContent: string, originalLineEnding: string): string {
  // Ensure all line endings match the original file
  if (originalLineEnding === '\r\n') {
    return newContent.replace(/\n/g, '\r\n');
  }
  return newContent;
}

// Edit preview type
interface EditPreview {
  originalContent: string;
  newContent: string;
  lineNumber: number;
  matchedAnchor?: string;
  contextVerified: boolean;
}

// File editing utilities
async function applyFileEdits(filePath: string, edits: z.infer<typeof EditOperation>[]): Promise<string | EditPreview[]> {
  // Read the file content
  let currentContent = await fs.readFile(filePath, 'utf-8');
  const previews: EditPreview[] = [];
  let lines = currentContent.split(/\r?\n/);
  
  // Sort edits by line number in descending order
  const sortedEdits = [...edits].sort((a, b) => {
    if (a.startLine && b.startLine) {
      return b.startLine - a.startLine;
    }
    return 0;
  });
  
  for (const edit of sortedEdits) {
    let startIdx = edit.startLine ? edit.startLine - 1 : -1;
    
    if (edit.findAnchor) {
      // Use line-by-line comparison for accurate anchor matching
      let foundLine = -1;
      const normalizedAnchor = normalizeForComparison(edit.findAnchor);
      
      for (let i = 0; i < lines.length; i++) {
        const normalizedLine = normalizeForComparison(lines[i]);
        if (normalizedLine.includes(normalizedAnchor)) {
          foundLine = i;
          break;
        }
      }
      if (foundLine === -1) {
        throw new Error(`Edit failed - anchor text not found: ${edit.findAnchor} in ${filePath}`);
      }
      startIdx = foundLine + (edit.anchorOffset || 0);
    }

    if (startIdx === -1) {
      throw new Error(`Edit failed - no valid position found in ${filePath}. Operation requires either startLine or findAnchor`);
    }

    // Context verification with normalized comparison
    let contextVerified = true;
    if (edit.beforeContext || edit.afterContext) {
      const radius = edit.contextRadius || 3;
      const beforeText = lines.slice(Math.max(0, startIdx - radius), startIdx).join('\n');
      const afterText = lines.slice(startIdx + 1, startIdx + radius + 1).join('\n');
      
      if (edit.beforeContext && !normalizeForComparison(beforeText).includes(normalizeForComparison(edit.beforeContext))) {
        contextVerified = false;
      }
      if (edit.afterContext && !normalizeForComparison(afterText).includes(normalizeForComparison(edit.afterContext))) {
        contextVerified = false;
      }
      
      if (!contextVerified && edit.verifyState) {
        throw new Error(
          `Edit failed - context verification failed in ${filePath} at line ${startIdx + 1}\n` +
          `Expected before context: ${edit.beforeContext}\n` +
          `Expected after context: ${edit.afterContext}\n` +
          `Found before context: ${beforeText}\n` +
          `Found after context: ${afterText}\n` +
          `Note: Indentation and line endings are normalized during comparison`
        );
      }
    }

    const oldLines = edit.oldText.split(/\r?\n/);
    const newLines = edit.newText.split(/\r?\n/);
    
    // Content verification with normalized comparison
    if (edit.verifyState) {
      const existingContent = lines.slice(startIdx, startIdx + oldLines.length).join('\n');
      if (normalizeForComparison(existingContent) !== normalizeForComparison(edit.oldText)) {
        throw new Error(
          `Edit failed - content mismatch in ${filePath} at line ${startIdx + 1}\n` +
          `Expected:\n${edit.oldText}\n` +
          `Found:\n${existingContent}\n` +
          `Note: Indentation and line endings are normalized during comparison`
        );
      }
    }

    if (edit.dryRun) {
      const originalContent = lines.slice(startIdx, startIdx + oldLines.length).join('\n');
      previews.push({
        originalContent,
        newContent: preserveIndentation(edit.newText, originalContent),
        lineNumber: startIdx + 1,
        matchedAnchor: edit.findAnchor,
        contextVerified
      });
      continue;
    }

    // Preserve indentation when applying edits
    const originalSegment = lines.slice(startIdx, startIdx + oldLines.length).join('\n');
    const indentedNewContent = preserveIndentation(edit.newText, originalSegment);
    const newContentLines = indentedNewContent.split(/\r?\n/);

    // Apply the edit based on insertMode
    switch (edit.insertMode) {
      case 'before':
        lines.splice(startIdx, 0, ...newContentLines);
        break;
      case 'after':
        lines.splice(startIdx + oldLines.length, 0, ...newContentLines);
        break;
      default: // 'replace'
        lines.splice(startIdx, oldLines.length, ...newContentLines);
    }

    // Re-read file if requested
    if (edit.readBeforeEdit) {
      const joinedContent = lines.join('\n');
      await fs.writeFile(filePath, joinedContent, 'utf-8');
      currentContent = await fs.readFile(filePath, 'utf-8');
      lines = currentContent.split(/\r?\n/);
    }
  }
  
  if (edits.some(e => e.dryRun)) {
    return previews;
  }
  
  // Join with the original line ending style
  return lines.join(detectLineEnding(currentContent));
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "read_file",
        description:
          "Read the complete contents of a file from the file system. " +
          "Handles various text encodings and provides detailed error messages " +
          "if the file cannot be read. Use this tool when you need to examine " +
          "the contents of a single file. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
      },
      {
        name: "read_multiple_files",
        description:
          "Read the contents of multiple files simultaneously. This is more " +
          "efficient than reading files one by one when you need to analyze " +
          "or compare multiple files. Each file's content is returned with its " +
          "path as a reference. Failed reads for individual files won't stop " +
          "the entire operation. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "write_file",
        description:
          "Create a new file or completely overwrite an existing file with new content. " +
          "Use with caution as it will overwrite existing files without warning. " +
          "Handles text content with proper encoding. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
      },
      {
        name: "edit_file",
        description:
          "Make selective edits to a text file with advanced pattern matching and validation. " +
          "Supports multiple edit modes:\n" +
          "1. Line-based: Use startLine to specify exact positions\n" +
          "2. Pattern-based: Use findAnchor to locate edit points by matching text\n" +
          "3. Context-aware: Verify surrounding text with beforeContext/afterContext\n\n" +
          "Features:\n" +
          "- Dry run mode for previewing changes (dryRun: true)\n" +
          "- Multiple insertion modes: 'replace', 'before', 'after'\n" +
          "- Anchor-based positioning with offset support\n" +
          "- Automatic state refresh between edits (readBeforeEdit)\n" +
          "- Context verification to ensure edit safety\n\n" +
          "Recommended workflow:\n" +
          "1. Use dryRun to preview changes\n" +
          "2. Use findAnchor for resilient positioning\n" +
          "3. Enable readBeforeEdit for multi-step changes\n" +
          "4. Verify context when position is critical\n\n" +
          "This is safer than complete file overwrites as it verifies existing content " +
          "and supports granular changes. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput,
      },
      {
        name: "create_directory",
        description:
          "Create a new directory or ensure a directory exists. Can create multiple " +
          "nested directories in one operation. If the directory already exists, " +
          "this operation will succeed silently. Perfect for setting up directory " +
          "structures for projects or ensuring required paths exist. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "list_directory",
        description:
          "Get a detailed listing of all files and directories in a specified path. " +
          "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
          "prefixes. This tool is essential for understanding directory structure and " +
          "finding specific files within a directory. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "move_file",
        description:
          "Move or rename files and directories. Can move files between directories " +
          "and rename them in a single operation. If the destination exists, the " +
          "operation will fail. Works across different directories and can be used " +
          "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
        inputSchema: zodToJsonSchema(MoveFileArgsSchema) as ToolInput,
      },
      {
        name: "search_files",
        description:
          "Recursively search for files and directories matching a pattern. " +
          "Searches through all subdirectories from the starting path. The search " +
          "is case-insensitive and matches partial names. Returns full paths to all " +
          "matching items. Great for finding files when you don't know their exact location. " +
          "Only searches within allowed directories.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
      },
      {
        name: "get_file_info",
        description:
          "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
          "information including size, creation time, last modified time, permissions, " +
          "and type. This tool is perfect for understanding file characteristics " +
          "without reading the actual content. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
      },
      {
        name: "list_allowed_directories",
        description: 
          "Returns the list of directories that this server is allowed to access. " +
          "Use this to understand which directories are available before trying to access files.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});


server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "read_file": {
        const parsed = ReadFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const content = await fs.readFile(validPath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "read_multiple_files": {
        const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_multiple_files: ${parsed.error}`);
        }
        const results = await Promise.all(
          parsed.data.paths.map(async (filePath: string) => {
            try {
              const validPath = await validatePath(filePath);
              const content = await fs.readFile(validPath, "utf-8");
              return `${filePath}:\n${content}\n`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `${filePath}: Error - ${errorMessage}`;
            }
          }),
        );
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }

      case "write_file": {
        const parsed = WriteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for write_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.writeFile(validPath, parsed.data.content, "utf-8");
        return {
          content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }],
        };
      }

      case "edit_file": {
        const parsed = EditFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for edit_file: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const result = await applyFileEdits(validPath, parsed.data.edits);
        
        // If it's a dry run, format the previews
        if (Array.isArray(result)) {
          const previewText = result.map(preview => 
            `Line ${preview.lineNumber}:\n` +
            `${preview.matchedAnchor ? `Matched anchor: ${preview.matchedAnchor}\n` : ''}` +
            `Context verified: ${preview.contextVerified}\n` +
            `Original:\n${preview.originalContent}\n` +
            `New:\n${preview.newContent}\n`
          ).join('\n---\n');
          
          return {
            content: [{ type: "text", text: `Edit preview:\n${previewText}` }],
          };
        }

        // Otherwise write the changes
        await fs.writeFile(validPath, result, "utf-8");
        return {
          content: [{ type: "text", text: `Successfully applied edits to ${parsed.data.path}` }],
        };
      }

      case "create_directory": {
        const parsed = CreateDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.mkdir(validPath, { recursive: true });
        return {
          content: [{ type: "text", text: `Successfully created directory ${parsed.data.path}` }],
        };
      }

      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const formatted = entries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "move_file": {
        const parsed = MoveFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for move_file: ${parsed.error}`);
        }
        const validSourcePath = await validatePath(parsed.data.source);
        const validDestPath = await validatePath(parsed.data.destination);
        await fs.rename(validSourcePath, validDestPath);
        return {
          content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
        };
      }

      case "search_files": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_files: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const results = await searchFiles(validPath, parsed.data.pattern);
        return {
          content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches found" }],
        };
      }

      case "get_file_info": {
        const parsed = GetFileInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const info = await getFileStats(validPath);
        return {
          content: [{ type: "text", text: Object.entries(info)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n") }],
        };
      }

      case "list_allowed_directories": {
        return {
          content: [{ 
            type: "text", 
            text: `Allowed directories:\n${allowedDirectories.join('\n')}` 
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Secure MCP Filesystem Server running on stdio");
  console.error("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});