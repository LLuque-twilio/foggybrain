import { useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeProps,
  type Edge,
  type Connection,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import {
  ArrowUpRight,
  Box,
  Check,
  ExternalLink,
  GitPullRequest,
  Link2,
  ListChecks,
} from 'lucide-react';
import type { Layout, Snapshot, TaskView } from '../shared';
import { Status } from './Status';
import { PrStatus } from './PrStatus';

type StepNode = Node<
  {
    task: TaskView;
    reference: boolean;
    completedChildren: number;
    open: (id: string) => void;
  },
  'step'
>;

function Step({ data, selected }: NodeProps<StepNode>) {
  const { task } = data;
  const Icon = task.kind === 'container' ? Box : task.kind === 'pr' ? GitPullRequest : ListChecks;
  return (
    <div className={`step-node ${selected ? 'is-selected' : ''} is-${task.status}`}>
      <Handle type="target" position={Position.Left} aria-label="Prerequisite input" />
      <div className="node-meta">
        <span>
          <Icon size={13} />
          {task.kind === 'pr'
            ? 'MERGE GATE'
            : task.kind === 'container'
              ? 'TASK CONTAINER'
              : 'MANUAL STEP'}
        </span>
        <span>
          {data.reference && <Link2 size={13} aria-label="Shared reference" />}
          {task.prUrl && (
            <a
              className="node-pr-link nodrag nopan"
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open PR for ${task.title} on GitHub`}
              title="Open PR on GitHub"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
        </span>
      </div>
      <div className="node-title">{task.title}</div>
      <div className="node-bottom">
        <Status status={task.status} />
        {task.kind === 'container' ? (
          <button
            className="node-open nodrag"
            onClick={(event) => {
              event.stopPropagation();
              data.open(task.id);
            }}
            aria-label={`Open ${task.title} graph`}
          >
            Open graph <ArrowUpRight size={13} />
          </button>
        ) : task.kind === 'pr' ? (
          <PrStatus task={task} />
        ) : (
          <span className="node-caption">
            {task.status === 'ready'
              ? 'Waiting on prerequisites'
              : task.waitingOn.length
                ? `${task.waitingOn.length} prerequisite${task.waitingOn.length === 1 ? '' : 's'}`
                : task.prUrl
                  ? 'Manual + PR gate'
                  : 'You decide when'}
          </span>
        )}
      </div>
      {task.kind === 'manual' && (
        <div className="node-manual-work">
          {task.manualDone ? <Check size={12} /> : <ListChecks size={12} />}
          {task.manualDone ? 'Manual work done' : 'Manual work not done'}
        </div>
      )}
      {task.kind === 'manual' && task.prUrl && (
        <div className="node-pr-gate">
          <span>PR gate</span>
          <PrStatus task={task} />
        </div>
      )}
      {task.kind === 'container' && (
        <div className="node-progress">
          <span
            style={{
              width: `${task.childrenIds.length ? (data.completedChildren / task.childrenIds.length) * 100 : 0}%`,
            }}
          />
        </div>
      )}
      <Handle type="source" position={Position.Right} aria-label="Dependent output" />
    </div>
  );
}

const nodeTypes = { step: Step };

interface Props {
  snapshot: Snapshot;
  viewId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
  onConnect: (connection: Connection) => void;
  onSelectEdge: (id: string) => void;
  onLayout: (layout: Layout) => void;
}

function Canvas({
  snapshot,
  viewId,
  selectedId,
  onSelect,
  onOpen,
  onConnect,
  onSelectEdge,
  onLayout,
}: Props) {
  const [nodes, setNodes] = useState<StepNode[]>([]);
  const { fitView } = useReactFlow();
  const parent = snapshot.tasks.find((task) => task.id === viewId);
  const tasks = snapshot.tasks.filter((task) =>
    viewId === 'root' ? task.parentId === null : parent?.childrenIds.includes(task.id),
  );
  const ids = new Set(tasks.map((task) => task.id));
  const layout = snapshot.layouts.find((layout) => layout.viewId === viewId);
  const manual = layout?.mode === 'manual';
  const dependencies = snapshot.dependencies.filter(
    (edge) => ids.has(edge.prerequisiteId) && ids.has(edge.dependentId),
  );
  const edges: Edge[] = dependencies.map((edge) => {
    const complete =
      snapshot.tasks.find((task) => task.id === edge.prerequisiteId)?.status === 'completed';
    return {
      id: edge.id,
      source: edge.prerequisiteId,
      target: edge.dependentId,
      type: 'smoothstep',
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: complete ? '#658c61' : '#a0aaa3',
        width: 17,
        height: 17,
      },
      style: { stroke: complete ? '#658c61' : '#a0aaa3', strokeWidth: 1.6 },
      ariaLabel: 'Dependency, select to inspect or remove',
      interactionWidth: 24,
    };
  });

  useEffect(() => {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR', nodesep: 44, ranksep: 76, marginx: 45, marginy: 45 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const task of tasks)
      graph.setNode(task.id, {
        width: 254,
        height: task.kind === 'manual' ? (task.prUrl ? 210 : 170) : 142,
      });
    for (const edge of dependencies) graph.setEdge(edge.prerequisiteId, edge.dependentId);
    dagre.layout(graph);
    setNodes(
      tasks.map((task) => {
        const stored = manual && layout.positions.find((position) => position.nodeId === task.id);
        const position = stored || {
          x: graph.node(task.id).x - 127,
          y: graph.node(task.id).y - graph.node(task.id).height / 2,
        };
        return {
          id: task.id,
          type: 'step',
          position: { x: position.x, y: position.y },
          selected: task.id === selectedId,
          data: {
            task,
            reference: task.parentId !== (viewId === 'root' ? null : viewId),
            open: onOpen,
            completedChildren: snapshot.tasks.filter(
              (child) => task.childrenIds.includes(child.id) && child.status === 'completed',
            ).length,
          },
        };
      }),
    );
    // Callbacks belong to this render; rebuilding is driven by server state or selection, not callback identity.
  }, [snapshot, viewId, selectedId]);

  const topology = `${viewId}:${tasks.map((task) => task.id).join(',')}:${dependencies.map((edge) => edge.id).join(',')}:${manual}`;
  useEffect(() => {
    const timer = setTimeout(() => {
      void fitView({ padding: 0.22, maxZoom: 1, duration: 250 });
    }, 80);
    return () => clearTimeout(timer);
  }, [topology, fitView]);

  return (
    <ReactFlow<StepNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={(changes) => setNodes((nodes) => applyNodeChanges(changes, nodes))}
      onNodeClick={(event, node) => {
        if (!(event.target as Element).closest('.react-flow__handle')) onSelect(node.id);
      }}
      onNodeDoubleClick={(_event, node) => {
        if (node.data.task.kind === 'container') onOpen(node.id);
      }}
      onPaneClick={() => onSelect(null)}
      onEdgeClick={(_event, edge) => onSelectEdge(edge.id)}
      onConnect={onConnect}
      nodesDraggable={manual}
      deleteKeyCode={null}
      onNodeDragStop={(_event, node) =>
        onLayout({
          viewId,
          mode: 'manual',
          positions: nodes.map((current) => ({
            nodeId: current.id,
            ...(current.id === node.id ? node.position : current.position),
          })),
        })
      }
      fitView
      minZoom={0.2}
      maxZoom={1.5}
      proOptions={{ hideAttribution: false }}
    >
      <Background color="#b9c6b8" gap={22} size={1} />
      <Controls showInteractive={false} />
      <MiniMap<StepNode>
        nodeColor={(node) =>
          node.selected ? '#7963b3' : node.data.task.status === 'completed' ? '#a0b78d' : '#d7dfce'
        }
        nodeStrokeColor={(node) => (node.selected ? '#4e387f' : 'transparent')}
        nodeStrokeWidth={3}
        maskColor="rgba(247,248,242,0.7)"
        pannable
        zoomable
      />
    </ReactFlow>
  );
}

export function Graph(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
