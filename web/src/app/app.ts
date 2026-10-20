import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { Api } from './api';
import { Ask } from './ask/ask';
import { AppConfig } from './models';
import { Review } from './review/review';

type Mode = 'ask' | 'review';

@Component({
  selector: 'app-root',
  imports: [Ask, Review],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private readonly api = inject(Api);

  protected readonly config = signal<AppConfig | null>(null);
  protected readonly configError = signal('');
  protected readonly mode = signal<Mode>('ask');

  async ngOnInit(): Promise<void> {
    try {
      this.config.set(await this.api.config());
    } catch {
      this.configError.set("Can't reach the local server. Start it with npm run web, then reload this page.");
    }
  }
}
