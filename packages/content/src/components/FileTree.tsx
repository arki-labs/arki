import { formatFileSize } from '@arki/math/format';
import { cn } from '@arki/ui/cn';
import { ArrowBendDownRight, File, FolderOpen } from '@arki/icons/phosphor';

type DirectoryNode = {
  name: string;
  type: 'directory';
  children: TreeNode[];
};

type FileNode = {
  name: string;
  type: 'file';
  size?: number;
};

type TreeNode = FileNode | DirectoryNode;

export type FileTreeProps = {
  nodes: TreeNode[];
  className?: string;
};

const isDirectory = (node: TreeNode): node is DirectoryNode => {
  return node.type === 'directory';
};

const isFile = (node: TreeNode): node is FileNode => {
  return node.type === 'file';
};

type FileSizeProps = {
  size?: number;
};

const FileSize = ({ size }: FileSizeProps) => {
  if (size === undefined || size === null) {
    return null;
  }
  return <span className="mr-2">({formatFileSize(size)})</span>;
};

type NodeProps = {
  node: TreeNode;
  depth: number;
};

const LeafNode = ({ node, depth }: NodeProps) => {
  const Icon = isDirectory(node) ? FolderOpen : File;
  return (
    <li className="flex gap-1">
      {depth > 0 ? (
        <div className="flex items-center justify-end" style={{ width: depth * 24 }}>
          <ArrowBendDownRight className="text-base-300 dark:text-base-600 w-4" />
        </div>
      ) : null}
      <Icon className="w-6" />
      <div className="flex w-full justify-between">
        <div>{node.name}</div>
        <div>{isFile(node) ? <FileSize size={node.size} /> : null}</div>
      </div>
    </li>
  );
};

const NonLeafNode = ({ node, depth }: NodeProps) => (
  <>
    <LeafNode node={node} depth={depth} />
    {isDirectory(node)
      ? (node.children || []).map(c => (
          <ul key={depth + '_' + c.name}>
            <NonLeafNode node={c} depth={depth + 1} />
          </ul>
        ))
      : null}
  </>
);

export const FileTree = ({ nodes, className }: FileTreeProps) => (
  <div
    className={cn(
      'not-prose border-base-300 dark:border-base-700 flex flex-col gap-2 overflow-x-scroll rounded-md border-2 p-5 shadow-md',
      className,
    )}
  >
    <ul className={'flex min-w-[460px] flex-col gap-2'}>
      {nodes.map(n => (
        <NonLeafNode key={n.name} node={n} depth={0} />
      ))}
    </ul>
  </div>
);
