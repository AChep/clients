import { Directive, EventEmitter, Input, OnDestroy, OnInit, Output } from "@angular/core";
import { ControlValueAccessor, FormControl, Validators } from "@angular/forms";
import { Subject, takeUntil } from "rxjs";

import { I18nService } from "@bitwarden/common/abstractions/i18n.service";
import { UserVerificationService } from "@bitwarden/common/abstractions/userVerification/userVerification.service.abstraction";
import { KeyConnectorService } from "@bitwarden/common/auth/abstractions/key-connector.service";
import { VerificationType } from "@bitwarden/common/auth/enums/verification-type";
import { Utils } from "@bitwarden/common/misc/utils";
import { Verification } from "@bitwarden/common/types/verification";

/**
 * Used for general-purpose user verification throughout the app.
 * Collects the user's master password, or if they are using Key Connector, prompts for an OTP via email.
 * This is exposed to the parent component via the ControlValueAccessor interface (e.g. bind it to a FormControl).
 * Use UserVerificationService to verify the user's input.
 */
@Directive({
  selector: "app-user-verification",
})
// eslint-disable-next-line rxjs-angular/prefer-takeuntil
export class UserVerificationComponent implements ControlValueAccessor, OnInit, OnDestroy {
  private _invalidSecret = false;
  @Input()
  get invalidSecret() {
    return this._invalidSecret;
  }
  set invalidSecret(value: boolean) {
    this._invalidSecret = value;
    this.invalidSecretChange.emit(value);
    if (value) {
      this.secret.markAsTouched();
    }
    this.secret.updateValueAndValidity({ emitEvent: false });
  }
  @Output() invalidSecretChange = new EventEmitter<boolean>();

  usesKeyConnector = true;
  disableRequestOTP = false;
  sentCode = false;

  secret = new FormControl("", [
    Validators.required,
    () => {
      if (this.invalidSecret) {
        return {
          invalidSecret: { message: this.i18nService.t("incorrectPassword") },
        };
      }
    },
  ]);

  private onChange: (value: Verification) => void;
  private destroy$ = new Subject<void>();

  constructor(
    private keyConnectorService: KeyConnectorService,
    private userVerificationService: UserVerificationService,
    private i18nService: I18nService
  ) {}

  async ngOnInit() {
    this.usesKeyConnector = await this.keyConnectorService.getUsesKeyConnector();
    this.processChanges(this.secret.value);

    this.secret.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe((secret: string) => this.processChanges(secret));
  }

  requestOTP = async () => {
    if (this.usesKeyConnector) {
      this.disableRequestOTP = true;
      try {
        await this.userVerificationService.requestOTP();
        this.sentCode = true;
      } finally {
        this.disableRequestOTP = false;
      }
    }
  };

  writeValue(obj: any): void {
    this.secret.setValue(obj);
  }

  registerOnChange(fn: any): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: any): void {
    // Not implemented
  }

  setDisabledState?(isDisabled: boolean): void {
    this.disableRequestOTP = isDisabled;
    if (isDisabled) {
      this.secret.disable();
    } else {
      this.secret.enable();
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  protected processChanges(secret: string) {
    this.invalidSecret = false;

    if (this.onChange == null) {
      return;
    }

    this.onChange({
      type: this.usesKeyConnector ? VerificationType.OTP : VerificationType.MasterPassword,
      secret: Utils.isNullOrWhitespace(secret) ? null : secret,
    });
  }
}
