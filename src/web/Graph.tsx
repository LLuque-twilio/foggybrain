import { useEffect, useMemo, useRef, useState } from 'react';
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
  BaseEdge,
  type Node,
  type NodeProps,
  type Edge,
  type EdgeProps,
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
  Sparkles,
} from 'lucide-react';
import type { Dependency, Layout, Snapshot, TaskStatus, TaskView } from '../shared';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip';
import { Status } from './Status';
import { PrStatus } from './PrStatus';

type StepNode = Node<
  {
    task: TaskView;
    reference: boolean;
    completedChildren: number;
    justUnlocked: boolean;
    open: (id: string) => void;
  },
  'step'
>;

function Step({ data, selected }: NodeProps<StepNode>) {
  const { task } = data;
  const Icon = task.kind === 'container' ? Box : task.kind === 'pr' ? GitPullRequest : ListChecks;
  const actionable = task.kind === 'manual' && task.status === 'available' && !task.manualDone;
  const prCue =
    task.prUrl && (task.kind === 'pr' || (task.kind === 'manual' && task.manualDone))
      ? task.prError
        ? 'stale'
        : task.prState === 'open'
          ? task.prMergeStatus
          : null
      : null;
  return (
    <div
      className={`step-node ${selected ? 'is-selected' : ''} is-${task.status}${actionable ? ' is-actionable' : ''}${data.justUnlocked ? ' is-just-unlocked' : ''}${prCue ? ` is-pr-${prCue}` : ''}`}
    >
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
          {actionable && data.justUnlocked && (
            <span className="node-start">
              <Sparkles size={11} aria-hidden="true" />
              Just unlocked
            </span>
          )}
          {task.prUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  className="node-pr-link nodrag nopan"
                  href={task.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open PR for ${task.title} on GitHub`}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </TooltipTrigger>
              <TooltipContent>Open PR on GitHub</TooltipContent>
            </Tooltip>
          )}
        </span>
      </div>
      <div className="node-title">{task.title}</div>
      <div className="node-bottom">
        <Status status={task.status} actionable={actionable} />
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
        <div className="node-progress-group">
          <div
            className="node-progress"
            role="progressbar"
            aria-label={`${data.completedChildren} of ${task.childrenIds.length} child tasks completed`}
            aria-valuemin={0}
            aria-valuemax={task.childrenIds.length}
            aria-valuenow={data.completedChildren}
          >
            {task.childrenIds.length <= 12 ? (
              Array.from({ length: task.childrenIds.length }, (_, index) => (
                <span
                  key={index}
                  className={`node-progress-segment${index < data.completedChildren ? ' is-complete' : ''}`}
                  aria-hidden="true"
                />
              ))
            ) : (
              <span
                className="node-progress-fill"
                aria-hidden="true"
                style={{ width: `${(data.completedChildren / task.childrenIds.length) * 100}%` }}
              />
            )}
          </div>
          <span className="node-progress-text">
            {task.childrenIds.length
              ? `${data.completedChildren} of ${task.childrenIds.length} steps complete`
              : 'No steps yet'}
          </span>
        </div>
      )}
      <Handle type="source" position={Position.Right} aria-label="Dependent output" />
    </div>
  );
}

const nodeTypes = { step: Step };
type Point = { x: number; y: number };
type RoutedStepEdge = Edge<{ points: Point[] }, 'routed'>;

function RoutedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  interactionWidth,
}: EdgeProps<RoutedStepEdge>) {
  const points = [
    { x: sourceX, y: sourceY },
    ...(data?.points ?? []),
    { x: targetX, y: targetY },
  ];
  // Horizontal tangents at every waypoint keep curves flowing left-to-right; waypoints come in
  // pairs spanning a skipped column, so the segment between them is a straight pass-through.
  const path = points
    .slice(1)
    .reduce((d, point, index) => {
      const previous = points[index];
      const bend = (point.x - previous.x) / 2;
      return `${d} C ${previous.x + bend} ${previous.y} ${point.x - bend} ${point.y} ${point.x} ${point.y}`;
    }, `M ${sourceX} ${sourceY}`);
  const middle = Math.floor((points.length - 2) / 2);
  const labelX = (points[middle].x + points[middle + 1].x) / 2;
  const labelY = (points[middle].y + points[middle + 1].y) / 2;
  return (
    <BaseEdge
      path={path}
      labelX={labelX}
      labelY={labelY}
      label={label}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      interactionWidth={interactionWidth}
      markerEnd={markerEnd}
      style={style}
    />
  );
}

const edgeTypes = { routed: RoutedEdge };

function autoLayout(
  tasks: TaskView[],
  dependencies: Dependency[],
  dimensions?: Map<string, { width: number; height: number }>,
) {
  const ranksep = 96;
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 44, ranksep, edgesep: 24, marginx: 45, marginy: 45 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const task of tasks) {
    const { width, height } = dimensions?.get(task.id) ?? {
      width: 254,
      height: task.kind === 'manual' ? (task.prUrl ? 210 : 170) : 142,
    };
    graph.setNode(task.id, { width, height });
  }
  for (const edge of dependencies)
    graph.setEdge(edge.prerequisiteId, edge.dependentId, { id: edge.id });
  dagre.layout(graph);
  const positions = new Map(
    tasks.map((task) => {
      const { x, y, width, height } = graph.node(task.id);
      return [task.id, { x: x - width / 2, y: y - height / 2 }] as const;
    }),
  );
  const columnWidth = Math.max(0, ...tasks.map((task) => graph.node(task.id).width));
  // Dagre also emits points at node borders and mid-gap; only the dummy points it reserved inside
  // skipped columns matter, and each is widened to span that column so the edge clears its cards.
  const routes = new Map(
    dependencies.map((edge) => {
      const source = graph.node(edge.prerequisiteId);
      const target = graph.node(edge.dependentId);
      const sourceRight = source.x + source.width / 2;
      const targetLeft = target.x - target.width / 2;
      const points = ((graph.edge(edge.prerequisiteId, edge.dependentId).points ?? []) as Point[])
        .filter((point) => point.x - sourceRight > ranksep && targetLeft - point.x > ranksep)
        .flatMap((point) => [
          { x: point.x - columnWidth / 2, y: point.y },
          { x: point.x + columnWidth / 2, y: point.y },
        ]);
      return [edge.id, points] as const;
    }),
  );
  return { positions, routes };
}

interface Props {
  snapshot: Snapshot;
  viewId: string;
  selectedId: string | null;
  selectedEdgeId: string | null;
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
  selectedEdgeId,
  onSelect,
  onOpen,
  onConnect,
  onSelectEdge,
  onLayout,
}: Props) {
  const [nodes, setNodes] = useState<StepNode[]>([]);
  const [autoRoutes, setAutoRoutes] = useState<{ viewId: string; routes: Map<string, Point[]> }>(
    () => ({ viewId: '', routes: new Map() }),
  );
  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(() => new Set());
  const previousStatuses = useRef<Map<string, TaskStatus> | null>(null);
  const unlockTimers = useRef(new Map<string, number>());
  const { fitView } = useReactFlow();
  useEffect(() => {
    const previous = previousStatuses.current;
    previousStatuses.current = new Map(snapshot.tasks.map((task) => [task.id, task.status]));
    if (!previous) return;
    const newlyUnlocked = snapshot.tasks.filter(
      (task) =>
        task.kind === 'manual' &&
        !task.manualDone &&
        task.status === 'available' &&
        previous.get(task.id) === 'blocked',
    );
    if (!newlyUnlocked.length) return;
    setUnlockedIds((current) => new Set([...current, ...newlyUnlocked.map((task) => task.id)]));
    for (const task of newlyUnlocked) {
      window.clearTimeout(unlockTimers.current.get(task.id));
      unlockTimers.current.set(
        task.id,
        window.setTimeout(() => {
          setUnlockedIds((current) => {
            const next = new Set(current);
            next.delete(task.id);
            return next;
          });
          unlockTimers.current.delete(task.id);
        }, 1800),
      );
    }
  }, [snapshot.tasks]);
  useEffect(() => {
    const timers = unlockTimers.current;
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);
  const taskById = useMemo(
    () => new Map(snapshot.tasks.map((task) => [task.id, task])),
    [snapshot.tasks],
  );
  const tasks = useMemo(() => {
    const childIds = new Set(taskById.get(viewId)?.childrenIds ?? []);
    return snapshot.tasks.filter((task) =>
      viewId === 'root' ? task.parentId === null : childIds.has(task.id),
    );
  }, [snapshot.tasks, taskById, viewId]);
  const ids = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  const layout = useMemo(
    () => snapshot.layouts.find((candidate) => candidate.viewId === viewId),
    [snapshot.layouts, viewId],
  );
  const manual = layout?.mode === 'manual';
  const dependencies = useMemo(
    () =>
      snapshot.dependencies.filter(
        (edge) => ids.has(edge.prerequisiteId) && ids.has(edge.dependentId),
      ),
    [snapshot.dependencies, ids],
  );
  const focusedIds = useMemo(() => {
    if (!selectedId || !ids.has(selectedId)) return null;
    const connected = new Set([selectedId]);
    for (const edge of dependencies) {
      if (edge.prerequisiteId === selectedId) connected.add(edge.dependentId);
      if (edge.dependentId === selectedId) connected.add(edge.prerequisiteId);
    }
    return connected;
  }, [selectedId, ids, dependencies]);
  const visibleNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        selected: node.id === selectedId,
        data: { ...node.data, justUnlocked: unlockedIds.has(node.id) },
        className: focusedIds
          ? focusedIds.has(node.id)
            ? node.id === selectedId
              ? ''
              : 'is-connected'
            : 'is-dimmed'
          : '',
      })),
    [nodes, selectedId, focusedIds, unlockedIds],
  );
  const edges = useMemo<Edge[]>(
    () =>
      dependencies.map((edge) => {
        const prerequisite = taskById.get(edge.prerequisiteId)!;
        const dependent = taskById.get(edge.dependentId)!;
        const state =
          prerequisite.status !== 'completed'
            ? 'waiting'
            : dependent.status === 'completed'
              ? 'settled'
              : 'released';
        const color =
          state === 'waiting' ? 'var(--graph-edge-waiting)' : 'var(--graph-edge-released)';
        const shortTitle = (title: string) =>
          title.length > 24 ? `${title.slice(0, 23)}…` : title;
        return {
          id: edge.id,
          source: edge.prerequisiteId,
          target: edge.dependentId,
          type: 'routed',
          data: {
            points:
              (!manual && autoRoutes.viewId === viewId && autoRoutes.routes.get(edge.id)) || [],
          },
          className: `dependency-edge dependency-edge--${state}${focusedIds && edge.prerequisiteId !== selectedId && edge.dependentId !== selectedId ? ' is-dimmed' : ''}`,
          animated: state === 'released',
          selected: edge.id === selectedEdgeId,
          label: `${shortTitle(prerequisite.title)} must finish before ${shortTitle(dependent.title)}`,
          labelStyle: { fill: 'var(--text-strong)', fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: 'var(--surface)' },
          labelBgPadding: [8, 6],
          labelBgBorderRadius: 5,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
            width: 17,
            height: 17,
          },
          style: { stroke: color, strokeWidth: edge.id === selectedEdgeId ? 2.6 : 1.8 },
          ariaLabel: `${prerequisite.title} is a prerequisite for ${dependent.title}; prerequisite ${prerequisite.status === 'completed' ? 'complete' : 'incomplete'}`,
          interactionWidth: 24,
        };
      }),
    [dependencies, focusedIds, selectedId, selectedEdgeId, taskById, manual, autoRoutes, viewId],
  );

  useEffect(() => {
    const { positions, routes } = autoLayout(tasks, dependencies);
    setAutoRoutes({ viewId, routes });
    const storedPositions = new Map(
      layout?.positions.map((position) => [position.nodeId, position]),
    );
    setNodes(
      tasks.map((task) => {
        const stored = manual ? storedPositions.get(task.id) : undefined;
        const position = stored || positions.get(task.id)!;
        return {
          id: task.id,
          type: 'step',
          position: { x: position.x, y: position.y },
          ariaLabel: `${task.title}, ${task.status} ${task.kind}`,
          ariaRole: 'button',
          data: {
            task,
            reference: task.parentId !== (viewId === 'root' ? null : viewId),
            justUnlocked: false,
            open: onOpen,
            completedChildren: task.childrenIds.reduce(
              (count, childId) => count + (taskById.get(childId)?.status === 'completed' ? 1 : 0),
              0,
            ),
          },
        };
      }),
    );
    // Callbacks and selection belong to this render; layout rebuilding follows server state, not their identity.
  }, [snapshot, viewId]);

  const dimensionsKey = nodes
    .map((node) => `${node.id}:${node.measured?.width ?? 0}:${node.measured?.height ?? 0}`)
    .join(',');
  useEffect(() => {
    if (
      manual ||
      nodes.length !== tasks.length ||
      nodes.some((node) => node.measured?.width === undefined || node.measured.height === undefined)
    )
      return;
    const dimensions = new Map(
      nodes.map((node) => [
        node.id,
        { width: node.measured!.width!, height: node.measured!.height! },
      ]),
    );
    if (tasks.some((task) => !dimensions.has(task.id))) return;
    const { positions, routes } = autoLayout(tasks, dependencies, dimensions);
    setAutoRoutes({ viewId, routes });
    setNodes((current) => {
      if (current.some((node) => !positions.has(node.id))) return current;
      const arranged = current.map((node) => {
        const position = positions.get(node.id)!;
        return Math.abs(node.position.x - position.x) < 0.5 &&
          Math.abs(node.position.y - position.y) < 0.5
          ? node
          : { ...node, position };
      });
      return arranged.every((node, index) => node === current[index]) ? current : arranged;
    });
  }, [dimensionsKey, manual, tasks, dependencies, viewId]);

  const topology = `${viewId}:${tasks.map((task) => `${task.id}:${task.kind}:${task.prUrl !== null}`).join(',')}:${dependencies.map((edge) => `${edge.id}:${edge.prerequisiteId}:${edge.dependentId}`).join(',')}:${manual}`;
  useEffect(() => {
    const timer = setTimeout(() => {
      void fitView({ padding: 0.22, maxZoom: 1, duration: 250 });
    }, 80);
    return () => clearTimeout(timer);
  }, [topology, dimensionsKey, fitView]);

  return (
    <ReactFlow<StepNode>
      nodes={visibleNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
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
      <Background color="var(--graph-grid)" gap={22} size={1} />
      <Controls showInteractive={false} />
      <MiniMap<StepNode>
        nodeColor={(node) =>
          node.selected
            ? 'var(--graph-selected)'
            : node.data.task.status === 'completed'
              ? 'var(--graph-completed)'
              : 'var(--graph-node)'
        }
        nodeStrokeColor={(node) => (node.selected ? 'var(--graph-selected-border)' : 'transparent')}
        nodeStrokeWidth={3}
        maskColor="var(--graph-mask)"
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
