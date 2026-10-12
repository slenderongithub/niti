import { Component, type ReactNode } from "react";
import { Bug, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

// A page that throws shows what broke and a way back, instead of blanking the whole window.
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[niti] ${this.props.name} crashed:`, error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div data-crashed={this.props.name} className="flex h-full items-center justify-center p-8">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bug />
            </EmptyMedia>
            <EmptyTitle>This view hit a problem</EmptyTitle>
            <EmptyDescription className="selectable font-mono text-xs">{this.state.error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
              <RotateCw /> Try again
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
}
